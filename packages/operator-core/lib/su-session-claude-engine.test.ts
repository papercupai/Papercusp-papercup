import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { contextTrimmingEnv, prepareSuLaunch } from '../../../apps/operator/scripts/psu-launcher.mjs';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { humanToolName } from './su-session-approval-display';
import {
  CHILD_STDERR_TAIL_LIMIT, attachChildStderr, childStderrSuffix, claudeDirectiveDispositionSuTools,
  claudeMemoryFilesInPrompt, claudePermissionMode, claudeReadOnlySuTools, createChildStderrTail,
  formatStalledTurnMessage, redactChildStderr, startClaudeSuEngine,
  type ClaudeEngineOptions, type ClaudeSuEngine,
} from './su-session-claude-engine';
import type { ClaudeSuRuntimeBinding } from './su-session-claude-adapter';

const nativeFunding = vi.hoisted(() => vi.fn<typeof import('./cupboard/identity-activation-gate-io').admitNativeIdentityInference>());
const forkPreparation = vi.hoisted(() => ({ prepare: vi.fn(), register: vi.fn(), cleanup: vi.fn() }));
vi.mock('./su-session-tracked-claude-fork', () => ({ prepareTrackedClaudeFork: forkPreparation.prepare }));
beforeEach(() => {
  forkPreparation.prepare.mockReset(); forkPreparation.register.mockReset(); forkPreparation.cleanup.mockReset();
  const transcriptPath = join(dir, 'fork-parent.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({ type: 'user', uuid: 'parent-prompt', message: { role: 'user', content: 'Parent visible input' } }) + '\n');
  forkPreparation.prepare.mockResolvedValue({ transcriptPath, register: forkPreparation.register, cleanup: forkPreparation.cleanup });
});
vi.mock('./cupboard/identity-activation-gate-io', () => ({ admitNativeIdentityInference: nativeFunding }));
beforeEach(() => { nativeFunding.mockReset(); nativeFunding.mockResolvedValue({ ok: true }); });

vi.mock('./su-session-persistence', () => ({
  persistSuSessionDescriptor: vi.fn(async () => true),
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  readDurableSuSession: vi.fn(async () => null),
  classifySuSessionRuntime: vi.fn(),
}));

const nativeId = '11111111-2222-4333-8444-555555555555';
const dir = mkdtempSync(join(tmpdir(), 'pui-engine-test-'));
const promptFile = join(dir, 'su.md');
writeFileSync(promptFile, 'SU persona and workspace scope.\n'.repeat(400));
const boot = {
  status: 'ok', specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
  codexHome: null, coordExtPath: null,
  agent: 'claude', sessionId: 61, nativeSessionId: nativeId, workspaceId: 'workspace',
  harnessSlug: 'project', planSlug: null, cwd: dir, promptFile,
  envelopeEnv: { PAPERCUSP_SID: 'su-test', PAPERCUSP_WORKSPACE: 'workspace', PAPERCUSP_HARNESS_SLUG: 'project', CLAUDE_CONFIG_DIR: dir },
} satisfies BootstrapSuResult;
const binding = {
  operation: 'created' as const, backend: 'claude' as const, advSessionId: 61,
  ownerId: 'su-test', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null, nativeSession: null,
};
const runtime = { nativeSession: {
  backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: 'su-test', sessionId: nativeId,
  configDir: dir, configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
  exactResumeSupported: true as const, missingReason: null,
}, transcriptPath: null };
const engines: ClaudeSuEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) { await engine.close(); engine.adapter.dispose(); } });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function peer(config: { identity?: string; cwd?: string; connected?: boolean; holdInit?: boolean; holdMcp?: boolean; pendingMcp?: boolean; noAck?: boolean; statusAck?: boolean; statusBeforeInput?: boolean; statusUuid?: string; holdResult?: boolean; streamOnly?: boolean; streamParent?: string;
  suTools?: Array<{ name: string; annotations?: { readOnly?: boolean } }> } = {}) {
  const output = new PassThrough({ objectMode: true });
  const prompts: SDKUserMessage[] = [];
  let receivedOptions: Options | undefined;
  const close = vi.fn(() => output.end());
  const interrupt = vi.fn(async () => undefined);
  let mcpReads = 0;
  const factory: NonNullable<ClaudeEngineOptions['query']> = ({ prompt, options }) => {
    receivedOptions = options;
    if (config.statusBeforeInput) output.write({
      type: 'system', subtype: 'status', status: 'requesting', session_id: nativeId,
      uuid: config.statusUuid ?? 'status-before-input',
    });
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message);
        if (config.statusAck) output.write({
          type: 'system', subtype: 'status', status: 'requesting', session_id: nativeId,
          uuid: config.statusUuid ?? message.uuid,
        });
        if (!config.noAck) {
          // A real CLI's turn metadata arrives only after a querying input.
          // No transcript-only startup traffic is fabricated by this peer.
          output.write({ type: 'system', subtype: 'init', session_id: config.identity ?? nativeId, cwd: config.cwd ?? dir });
          if (config.streamOnly) {
            if (options.includePartialMessages) output.write({
              type: 'stream_event', session_id: nativeId, parent_tool_use_id: config.streamParent ?? null,
              event: { type: 'message_start', message: { id: 'native-long-reply', role: 'assistant', content: [] } },
            });
            continue;
          }
          output.write(message);
          if (config.holdResult) continue;
          output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'Correlated reply' }] } });
          output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        }
      }
    })();
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>,
      initializationResult: vi.fn(async () => {
        if (config.holdInit) await new Promise(() => {});
        return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] };
      }),
      mcpServerStatus: vi.fn(async () => {
        if (config.holdMcp) await new Promise(() => {});
        // Like the CLI: a strict MCP config loads only the servers passed in.
        if (receivedOptions?.strictMcpConfig && !receivedOptions.mcpServers?.['papercusp-su']) return [];
        if (config.pendingMcp && mcpReads++ === 0) return [{ name: 'papercusp-su', status: 'pending' as const }];
        return [{ name: 'papercusp-su', status: config.connected === false ? 'failed' as const : 'connected' as const,
          ...(config.suTools ? { tools: config.suTools } : {}) }];
      }),
      interrupt, close,
    };
  };
  return { factory, output, prompts, close, interrupt, options: () => receivedOptions };
}
function open(p = peer(), extra: Partial<ClaudeEngineOptions> = {}, nativeRuntime: ClaudeSuRuntimeBinding = runtime) {
  const engine = startClaudeSuEngine(boot, binding, nativeRuntime, { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300, ...extra });
  engines.push(engine);
  return engine;
}
function command(engine: ClaudeSuEngine, type: 'owner_turn' | 'interrupt' | 'end' = 'owner_turn') {
  return { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId: `cmd-${type}`, issuedAt: '2026-09-07T00:00:00Z', target: engine.adapter.host.descriptor().identity,
    type, ...(type === 'owner_turn' ? { turnId: 'owner-turn-1', content: '  hi 雪\n\n' } : {}),
  };
}
function openCards(engine: ClaudeSuEngine) {
  const events = engine.adapter.host.recent.map(({ event }) => event);
  const closed = new Set(events.flatMap((event) => event.type === 'card' && event.phase === 'closed' ? [event.correlationId] : []));
  return events.flatMap((event) => event.type === 'card' && event.phase === 'opened' && !closed.has(event.card.correlationId) ? [event.card] : []);
}

function stalledReports(engine: ClaudeSuEngine) {
  return engine.adapter.host.recent.map(({ event }) => event)
    .filter((event) => event.type === 'error' && event.code === 'claude_turn_stalled');
}

describe('structured Claude SU engine', () => {
  const forkSource = { advSessionId: 60, nativeSession: { ...runtime.nativeSession,
    ownerId: 'parent-owner', sessionId: '22222222-2222-4222-8222-222222222222', configDir: join(dir, 'parent') } };

  it('forks through the SDK and waits for tracked lineage registration before readiness', async () => {
    let release!: () => void;
    forkPreparation.register.mockImplementation(async () => new Promise<void>(done => { release = done; }));
    const p = peer(), engine = open(p, { forkFrom: forkSource, startupTimeoutMs: 2_000 });
    await vi.waitFor(() => expect(forkPreparation.register).toHaveBeenCalledOnce());
    expect(p.options()).toMatchObject({ resume: forkSource.nativeSession.sessionId, forkSession: true, sessionId: nativeId });
    expect(engine.adapter.host.snapshot().streamReady).toBe(false);
    expect(p.prompts).toHaveLength(0);
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && 'content' in event && event.content === 'Parent visible input')).toBe(true);
    release(); await engine.ready;
    expect(engine.adapter.host.snapshot().streamReady).toBe(true);
    expect(forkPreparation.cleanup).not.toHaveBeenCalled();
  });

  it('closes the native fork and cleans its artifacts when lineage registration refuses', async () => {
    forkPreparation.register.mockRejectedValue(new Error('lineage changed'));
    const p = peer(), engine = open(p, { forkFrom: forkSource });
    await expect(engine.ready).rejects.toThrow('lineage changed');
    expect(engine.adapter.host.snapshot().streamReady).toBe(false);
    expect(p.close).toHaveBeenCalled();
    expect(p.prompts).toHaveLength(0);
    expect(forkPreparation.cleanup).toHaveBeenCalledOnce();
  });

  it('rechecks a file revoked while native admission was pending', async () => {
    const p = peer(), engine = open(p), path = join(dir, 'admission-notes.txt'), bytes = Buffer.from('private notes');
    writeFileSync(path, bytes);
    await engine.ready;
    let release!: () => void;
    nativeFunding.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return { ok: true }; });
    const turn = engine.adapter.host.startCommand({ ...command(engine), input: [{ type: 'file',
      uri: 'project:admission-notes.txt', mediaType: 'text/plain', workspaceId: 'workspace',
      sha256: createHash('sha256').update(bytes).digest('hex') }] });
    await vi.waitFor(() => expect(nativeFunding).toHaveBeenCalledOnce());
    chmodSync(path, 0); release();
    await expect(turn.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'input_unreadable' } });
    expect(p.prompts).toHaveLength(0);
    expect(p.close).not.toHaveBeenCalled();
  });

  it('SU-EXEC R-6 acceptance contract: delivers typed image content and advertises only attached rich input', async () => {
    const p = peer(), engine = open(p);
    await engine.ready;
    expect(engine.adapter.host.descriptor().capabilities.input?.parts).toEqual(['text', 'image', 'file']);
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
    await expect(engine.adapter.host.startCommand({ ...command(engine), input: [{ type: 'image', mediaType: 'image/png', data }] }).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts[0].message.content).toEqual([{ type: 'text', text: '  hi 雪\n\n' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
  });

  it.each(['revoked', 'moved', 'expired', 'foreign-workspace', 'changed', 'unsupported-media'] as const)(
    'SU-EXEC R-6 acceptance contract: refuses %s references at the SDK delivery boundary', async scenario => {
      const root = mkdtempSync(join(dir, 'reference-'));
      const path = join(root, 'notes.txt'), bytes = Buffer.from('Selected file answer: 雪');
      writeFileSync(path, bytes);
      const p = peer(), engine = open(p);
      // The engine's authenticated project root selects authority.
      const relativePath = path.slice(dir.length + 1);
      const input = [{ type: 'file' as const, uri: `project:${relativePath}`, workspaceId: 'workspace',
        sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/plain' }];
      await engine.ready;
      await expect(engine.adapter.host.startCommand({ ...command(engine), input }).terminal)
        .resolves.toMatchObject({ status: 'completed' });
      expect(p.prompts[0].message.content).toEqual([{ type: 'text', text: '  hi 雪\n\n' },
        { type: 'text', text: `File project:${relativePath}\n${bytes.toString()}` }]);
      if (scenario === 'revoked') chmodSync(path, 0);
      if (scenario === 'moved') renameSync(path, join(root, 'moved.txt'));
      if (scenario === 'changed') writeFileSync(path, 'Replacement content');
      const replay = JSON.parse(JSON.stringify(input));
      if (scenario === 'expired') replay[0].expiresAt = '2000-01-01T00:00:00Z';
      if (scenario === 'foreign-workspace') replay[0].workspaceId = 'other-workspace';
      if (scenario === 'unsupported-media') replay[0].mediaType = 'application/zip';
      const expected = scenario === 'expired' ? 'input_expired'
        : scenario === 'foreign-workspace' ? 'input_workspace_mismatch'
          : scenario === 'changed' ? 'input_identity_changed'
            : scenario === 'unsupported-media' ? 'unsupported_input_media_type' : 'input_unreadable';
      await expect(engine.adapter.host.startCommand({ ...command(engine), commandId: `replay-${scenario}`,
        turnId: `replay-${scenario}`, input: replay }).terminal)
        .resolves.toMatchObject({ status: 'refused', refusal: { code: expected } });
      expect(p.prompts).toHaveLength(1);
      expect(p.close).not.toHaveBeenCalled();
    },
  );

  it('preserves typed input refusal without closing the Claude connection', async () => {
    const p = peer(), engine = open(p);
    await engine.ready;
    await expect(engine.adapter.host.startCommand({ ...command(engine), commandId: 'invalid-image',
      input: [{ type: 'image', mediaType: 'image/jpeg', data: 'YWJj' }] }).terminal)
      .resolves.toMatchObject({ status: 'refused', refusal: { code: 'input_media_mismatch' } });
    expect(p.prompts).toHaveLength(0);
    await expect(engine.adapter.host.startCommand({ ...command(engine), commandId: 'after-refusal' }).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts).toHaveLength(1);
    expect(p.close).not.toHaveBeenCalled();
  });

  it.each([undefined, 'prompt'] as const)('consumes complete canonical preparation at the SDK boundary (approval=%s)', async toolApproval => {
    const p = peer();
    const selected = { ...boot, model: 'claude-sonnet-4-6:high', envelopeEnv: {
      ...boot.envelopeEnv, ...contextTrimmingEnv('claude'), PAPERCUSP_PLAN_SLUG: 'chosen-plan',
      PAPERCUSP_AUTO_MODE: '1', PAPERCUSP_LAUNCH_CONTEXT_FILE: promptFile,
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin', PAPERCUSP_ACCOUNT_ID: 'chosen-claude',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', PAPERCUSP_TTY: '/dev/pts/parent',
    } };
    const prepared = prepareSuLaunch(selected, { executionKind: 'programmatic', accountRoute: 'chosen-claude' });
    const engine = startClaudeSuEngine(selected, binding, runtime, {
      agentChatId: 'chat', model: 'stale-caller:low', accountRoute: 'chosen-claude',
      query: p.factory, register: false, startupTimeoutMs: 300, toolApproval,
    });
    engines.push(engine); await engine.ready;
    const actual = p.options()!;
    // Adapter-specific additions are allowed; every prepared input survives.
    for (const [key, value] of Object.entries(prepared.env)) expect(actual.env?.[key], key).toBe(value);
    expect(actual).toMatchObject({ cwd: prepared.cwd, model: 'claude-sonnet-4-6', effort: 'high',
      systemPrompt: { type: 'custom', prompt: readFileSync(promptFile, 'utf8'), snapshot: true },
      settingSources: ['user', 'project', 'local'],
      permissionMode: toolApproval === 'prompt' ? 'default' : 'bypassPermissions' });
    expect(actual.env).not.toHaveProperty('PAPERCUSP_TTY');
    expect(actual.disallowedTools).toEqual(prepared.args.filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('--disallowedTools='))
      .flatMap(arg => arg.slice('--disallowedTools='.length).split(',')));
    expect(actual.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent']));
    expect(typeof actual.settings === 'object' ? actual.settings.disableAllHooks : undefined).not.toBe(true);
    expect(actual.strictMcpConfig).not.toBe(true);
    expect(actual.env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(actual.env?.PAPERCUSP_LAUNCH_CONTEXT_FILE).toBe(promptFile);
  });

  it('consumes the resolved bootstrap model and effort instead of a stale caller selection', async () => {
    const p = peer();
    const engine = startClaudeSuEngine({ ...boot, model: 'claude-sonnet-4-6:high' }, binding, runtime, {
      agentChatId: 'chat', model: 'claude-opus-4-1:low', accountRoute: 'default',
      query: p.factory, register: false, startupTimeoutMs: 300,
    });
    engines.push(engine);
    await engine.ready;
    expect(p.options()).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'high', cwd: dir,
      env: { PAPERCUSP_SID: 'su-test', CLAUDE_CONFIG_DIR: dir } });
    expect(p.options()?.env).not.toHaveProperty('PAPERCUSP_TTY');
  });

  it('awaits the exact native funding guard before writing querying input', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    nativeFunding.mockImplementationOnce(async () => { await barrier; return { ok: true }; });
    const p = peer(), engine = open(p); await engine.ready;
    expect(engine.adapter.host.descriptor()).toMatchObject({ identity: { backend: 'claude' }, executionKind: 'programmatic' });
    const dispatch = engine.adapter.host.startCommand(command(engine) as never);
    await vi.waitFor(() => expect(nativeFunding).toHaveBeenCalledOnce());
    expect(nativeFunding).toHaveBeenCalledWith({ workspaceId: 'workspace', ownerId: 'su-test', backend: 'claude' });
    expect(p.prompts).toHaveLength(0);
    release();
    await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts).toHaveLength(1);
  });

  it('cancels the admitting turn without dropping later queued inputs', async () => {
    let release!: () => void;
    nativeFunding.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true };
    });
    const p = peer(), engine = open(p); await engine.ready;
    const host = engine.adapter.host;
    const first = host.startCommand(command(engine));
    await vi.waitFor(() => expect(nativeFunding).toHaveBeenCalledOnce());
    const queued = { ...command(engine), type: 'queue' as const, commandId: 'after-admission', turnId: 'after-admission', content: 'keep this follow-up' };
    const follow = host.startCommand(queued);
    await expect(host.startCommand(command(engine, 'interrupt')).terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.interrupt).not.toHaveBeenCalled();
    release();
    await expect(first.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'turn_interrupted' } });
    await expect(follow.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts.map(prompt => prompt.message.content)).toEqual(['keep this follow-up']);
    expect(p.prompts[0].session_id).toBe(nativeId);
    expect(host.startCommand(queued).replayed).toBe(true);
    expect(host.recent.filter(({ event }) => event.type === 'command_result'
      && event.commandId === 'cmd-owner_turn' && event.status !== 'accepted')).toHaveLength(1);
  });

  it.each(['model', 'approvals'] as const)('cancels input interrupted during the %s switch', async control => {
    let release!: () => void;
    const switchControl = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const p = peer();
    const factory: NonNullable<ClaudeEngineOptions['query']> = args => Object.assign(p.factory(args),
      control === 'model' ? { setModel: switchControl } : { setPermissionMode: switchControl });
    const engine = open({ ...p, factory }, { model: 'claude-opus-4-1' }); await engine.ready;
    const first = engine.adapter.host.startCommand({ ...command(engine),
      ...(control === 'model' ? { model: 'claude-sonnet-4-6' } : { approvals: 'read-only' as const }) });
    await vi.waitFor(() => expect(switchControl).toHaveBeenCalledOnce());
    await expect(engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal).resolves.toMatchObject({ status: 'completed' });
    release();
    await expect(first.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'turn_interrupted' } });
    expect(p.prompts).toHaveLength(0);
    expect(p.interrupt).not.toHaveBeenCalled();
    await expect(engine.adapter.host.startCommand({ ...command(engine), commandId: 'next', turnId: 'next' }).terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts).toHaveLength(1);
  });

  it('refuses unpaid or unsupported paid inference without writing querying input', async () => {
    nativeFunding.mockResolvedValueOnce({ ok: false, code: 'identity-native-billing-unsupported',
      message: 'Provider-billed request cost is unavailable', retryable: false });
    const p = peer(), engine = open(p); await engine.ready;
    const dispatch = engine.adapter.host.startCommand(command(engine) as never);
    await expect(dispatch.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'identity-native-billing-unsupported' } });
    expect(p.prompts).toHaveLength(0);
  });

  it('keeps ordinary coding-assistant input independent of SU identity funding', async () => {
    const p = peer(), engine = open(p, { identity: 'coding-assistant' }); await engine.ready;
    const dispatch = engine.adapter.host.startCommand(command(engine) as never);
    await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(nativeFunding).not.toHaveBeenCalled();
    expect(p.prompts).toHaveLength(1);
  });

  it.each([
    { toolApproval: undefined, permissionMode: 'bypassPermissions', dangerouslySkip: true },
    { toolApproval: 'prompt' as const, permissionMode: 'default', dangerouslySkip: undefined },
  ])('maps tool approval $toolApproval to the native SDK policy', async ({ toolApproval, permissionMode, dangerouslySkip }) => {
    const p = peer();
    const engine = open(p, toolApproval ? { toolApproval } : {});
    await engine.ready;
    expect(p.options()?.permissionMode).toBe(permissionMode);
    expect(p.options()?.allowDangerouslySkipPermissions).toBe(dangerouslySkip);
  });

  it('keeps restored history in startup until the new executor is ready', async () => {
    const transcriptPath = join(dir, 'history-readiness.jsonl');
    writeFileSync(transcriptPath, [
      { type: 'user', sessionId: nativeId, uuid: 'saved-user', message: { role: 'user', content: 'Saved greeting' } },
      { type: 'assistant', sessionId: nativeId, uuid: 'saved-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }] } },
      { type: 'result', sessionId: nativeId, subtype: 'success', is_error: false },
    ].map((record) => JSON.stringify(record) + '\n').join(''));
    let beforeReady: ReturnType<ClaudeSuEngine['adapter']['host']['snapshot']> | undefined;
    const p = peer();
    const engine = open(p, { resume: true, beforeReady: async () => {
      beforeReady = engine.adapter.host.snapshot();
    } }, { ...runtime, transcriptPath });
    await engine.ready;
    expect(p.options()?.systemPrompt).toEqual({
      type: 'custom', prompt: readFileSync(promptFile, 'utf8'), snapshot: true,
    });
    expect(p.options()?.env?.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED).toBe('1');
    expect(p.options()?.extraArgs).not.toHaveProperty('system-prompt-file');
    expect(beforeReady).toMatchObject({ streamReady: false, executorAttached: false,
      descriptor: { lifecycle: expect.stringMatching(/^(starting|resuming)$/) } });
    expect(engine.adapter.host.recent.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'transcript', phase: 'completed', role: 'assistant', content: 'Saved reply' }),
    ]));
    expect(engine.adapter.host.snapshot()).toMatchObject({ streamReady: true, executorAttached: true,
      descriptor: { lifecycle: 'ready' } });
  });

  it('restores historical assistant text without sending a new native turn', async () => {
    const transcriptPath = join(dir, 'saved-history.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: nativeId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Saved assistant reply' }] } }) + '\n');
    const p = peer();
    const engine = open(p, { resume: true }, { ...runtime, transcriptPath });
    await engine.ready;
    expect(engine.adapter.host.recent.map(({ event }) => event).filter((event) =>
      event.type === 'transcript' && event.phase === 'completed' && event.role === 'assistant'))
      .toEqual([expect.objectContaining({ content: 'Saved assistant reply' })]);
    expect(p.prompts).toHaveLength(0);
  });

  it('refuses resume readiness when saved history cannot be read', async () => {
    const engine = open(peer(), { resume: true }, { ...runtime, transcriptPath: join(dir, 'missing.jsonl') });
    await expect(engine.ready).rejects.toThrow('ENOENT');
    expect(engine.adapter.host.snapshot().streamReady).toBe(false);
  });

  it('requires initialized SDK controls and SU tools without inventing a startup model turn', async () => {
    const p = peer(); const engine = open(p);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('starting');
    expect((await engine.adapter.host.acceptCommand(command(engine))).accepted).toBeNull();
    await engine.ready;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
    expect(engine.adapter.host.snapshot()).toMatchObject({ executorAttached: true, streamReady: true });
    expect(p.options()).toMatchObject({ sessionId: nativeId, cwd: dir, env: boot.envelopeEnv });
    expect(p.options()?.systemPrompt).toEqual({
      type: 'custom', prompt: readFileSync(promptFile, 'utf8'), snapshot: true,
    });
    expect(p.options()?.env?.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED).toBe('1');
    expect(p.options()?.extraArgs).not.toHaveProperty('system-prompt-file');
    expect(p.options()?.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent', 'Workflow']));
    expect(p.prompts).toHaveLength(0);
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript')).toBe(false);
  });

  describe('engine identity (pui-chat-first-ux-2026-09-28 D-004)', () => {
    const hooksDisabled = (options: Options | undefined) =>
      typeof options?.settings === 'object' ? options.settings.disableAllHooks : undefined;

    it('runs Claude Code\'s own prompt with no hooks and no MCP servers as a coding assistant', async () => {
      const p = peer(); const engine = open(p, { identity: 'coding-assistant' });
      await engine.ready;
      expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
      const options = p.options();
      expect(options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
      expect(options?.strictMcpConfig).toBe(true);
      expect(options?.mcpServers).toEqual({});
      expect(hooksDisabled(options)).toBe(true);
      // Its dynamic sections (cwd, git state, date) are what ground it in the directory.
      expect(options?.extraArgs).not.toHaveProperty('exclude-dynamic-system-prompt-sections');
      expect(options?.extraArgs).toHaveProperty('replay-user-messages');
      // Nothing of the SU persona reaches the child.
      expect(JSON.stringify(options?.systemPrompt)).not.toContain('SU persona');
      expect(typeof options?.settings === 'object' ? options.settings.claudeMdExcludes : undefined).toBeUndefined();
      // The session's own rails are unchanged.
      expect(options).toMatchObject({ sessionId: nativeId, cwd: dir, permissionMode: 'bypassPermissions' });
      expect(options?.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent', 'Workflow']));
    });

    it('becomes ready with no SU tool connection, which an SU session refuses', async () => {
      const assistant = open(peer(), { identity: 'coding-assistant' });
      await expect(assistant.ready).resolves.toBeUndefined();
      expect(assistant.adapter.host.snapshot()).toMatchObject({ executorAttached: true, streamReady: true });
      const su = open(peer({ connected: false }));
      await expect(su.ready).rejects.toThrow(/SU tool connection is failed/);
    });

    it('keeps the SU persona, hooks and SU tools by default', async () => {
      const p = peer(); const engine = open(p);
      await engine.ready;
      const options = p.options();
      expect(options?.systemPrompt).toMatchObject({ type: 'custom', snapshot: true });
      expect(options?.strictMcpConfig).toBeUndefined();
      expect(options?.mcpServers).toBeUndefined();
      expect(hooksDisabled(options)).toBeUndefined();
      expect(options?.extraArgs).toHaveProperty('exclude-dynamic-system-prompt-sections');
    });

    it('keeps the coding-assistant identity on an exact resume', async () => {
      const transcriptPath = join(dir, 'history-coding-assistant.jsonl');
      writeFileSync(transcriptPath, [
        { type: 'user', sessionId: nativeId, uuid: 'saved-user', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', sessionId: nativeId, uuid: 'saved-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi! What are we working on?' }] } },
        { type: 'result', sessionId: nativeId, subtype: 'success', is_error: false },
      ].map((record) => JSON.stringify(record) + '\n').join(''));
      const p = peer();
      const engine = open(p, { identity: 'coding-assistant', resume: true }, { ...runtime, transcriptPath });
      await engine.ready;
      expect(p.options()).toMatchObject({ resume: nativeId, strictMcpConfig: true, systemPrompt: { type: 'preset', preset: 'claude_code' } });
      expect(hooksDisabled(p.options())).toBe(true);
    });
  });

  describe('SU tool surface', () => {
    const trimming = ['PAPERCUSP_TOOLS', 'PAPERCUSP_TOOLS_COMPACT', 'PAPERCUSP_CONTEXT_TIER', 'ENABLE_TOOL_SEARCH'];
    beforeEach(() => { for (const key of trimming) vi.stubEnv(key, undefined); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('launches on the same trimmed tool seed as a psu launch', async () => {
      const p = peer(); const engine = open(p);
      await engine.ready;
      const expected = contextTrimmingEnv('claude');
      // An empty seed would expand to `&tools=` on the MCP url and advertise the whole catalog.
      expect(expected.PAPERCUSP_TOOLS).not.toBe('');
      expect(p.options()?.env).toMatchObject(expected);
    });

    it('keeps a tool seed the bootstrap envelope already carried', async () => {
      const p = peer();
      const engine = startClaudeSuEngine({ ...boot, envelopeEnv: { ...boot.envelopeEnv, PAPERCUSP_TOOLS: 'coord_orient' } }, binding, runtime,
        { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300 });
      engines.push(engine);
      await engine.ready;
      expect(p.options()?.env?.PAPERCUSP_TOOLS).toBe('coord_orient');
      expect(p.options()?.env?.PAPERCUSP_CONTEXT_TIER).toBe('trimmed');
    });
  });

  it('delivers exact owner text and correlates the reply with the PUI turn', async () => {
    const p = peer();
    const servedAccountReader = vi.fn(async (_ownerId: string) => 'pool-claude-success');
    const engine = open(p, { servedAccountReader }); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result.status).toBe('completed');
    await vi.waitFor(() => expect(engine.adapter.host.descriptor()).toMatchObject({
      lifecycle: 'waiting-for-owner', accountServed: 'pool-claude-success',
    }));
    expect(servedAccountReader).toHaveBeenCalledWith('su-test');
    expect(p.prompts[0].message.content).toBe('  hi 雪\n\n');
    expect(p.prompts[0].origin).toEqual({ kind: 'human' });
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'assistant', turnId: 'owner-turn-1', content: 'Correlated reply',
    }));
  });

  // pui-chat-first-ux P-026 / D-025: /model's pick rides on the next owner turn.
  describe('P-026 model switching', () => {
    function switchable(p: ReturnType<typeof peer>, controls: 'both' | 'none' = 'both') {
      const order: string[] = [];
      const setModel = vi.fn(async (model?: string) => { order.push(`setModel:${model}:after-${p.prompts.length}-prompts`); });
      const applyFlagSettings = vi.fn(async (settings: { effortLevel?: string }) => {
        order.push(`effort:${settings.effortLevel}:after-${p.prompts.length}-prompts`);
      });
      const factory: NonNullable<ClaudeEngineOptions['query']> = (args) => {
        const query = p.factory(args);
        return controls === 'both' ? Object.assign(query, { setModel, applyFlagSettings }) as typeof query : query;
      };
      return { peer: { ...p, factory }, setModel, applyFlagSettings, order };
    }
    const withModel = (engine: ClaudeSuEngine, model: string, id = 'switch') =>
      ({ ...command(engine), commandId: `cmd-${id}`, turnId: `owner-${id}`, model });

    it('switches before the turn is written and names the model on the session', async () => {
      const s = switchable(peer());
      const engine = open(s.peer, { model: 'claude-opus-4-1' }); await engine.ready;
      const result = await engine.adapter.host.startCommand(withModel(engine, 'claude-sonnet-4-5:high')).terminal;
      expect(result.status).toBe('completed');
      expect(s.order).toEqual(['setModel:claude-sonnet-4-5:after-0-prompts', 'effort:high:after-0-prompts']);
      expect(s.peer.prompts).toHaveLength(1);
      expect(engine.adapter.host.descriptor()).toMatchObject({
        model: 'claude-sonnet-4-5:high',
        ownerSelectedModel: 'claude-sonnet-4-5:high',
      });
    });

    it('does not switch for a turn naming the current model', async () => {
      const s = switchable(peer());
      const engine = open(s.peer, { model: 'claude-opus-4-1' }); await engine.ready;
      await engine.adapter.host.startCommand(withModel(engine, 'claude-opus-4-1')).terminal;
      expect(s.setModel).not.toHaveBeenCalled();
      expect(s.peer.prompts).toHaveLength(1);
    });

    it('refuses the turn, writes nothing and stays usable when the connection cannot switch', async () => {
      const s = switchable(peer(), 'none');
      const engine = open(s.peer, { model: 'claude-opus-4-1' }); await engine.ready;
      const refused = await engine.adapter.host.startCommand(withModel(engine, 'claude-haiku-4-5')).terminal;
      expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'model_switch_refused', retryable: false,
        liftsWhen: expect.stringContaining('omit the model override') } });
      expect(s.peer.prompts).toHaveLength(0);
      expect(engine.adapter.host.descriptor().model).not.toBe('claude-haiku-4-5');
      const next = await engine.adapter.host.startCommand({ ...command(engine), commandId: 'cmd-after', turnId: 'owner-after' }).terminal;
      expect(next.status).toBe('completed');
      expect(s.peer.prompts).toHaveLength(1);
    });
  });

  // pui-chat-first-ux P-027 / D-026: /approvals rides on the next owner turn.
  describe('D-026 approvals switching', () => {
    function permissionable(p: ReturnType<typeof peer>, withControl = true) {
      const order: string[] = [];
      const setPermissionMode = vi.fn(async (mode: string) => { order.push(`mode:${mode}:after-${p.prompts.length}-prompts`); });
      const factory: NonNullable<ClaudeEngineOptions['query']> = (args) => {
        const query = p.factory(args);
        return withControl ? Object.assign(query, { setPermissionMode }) as typeof query : query;
      };
      return { peer: { ...p, factory }, setPermissionMode, order };
    }
    const withApprovals = (engine: ClaudeSuEngine, approvals: string, id = 'approvals') =>
      ({ ...command(engine), commandId: `cmd-${id}`, turnId: `owner-${id}`, approvals }) as never;

    it('a prompted launch reports ask, and a switch applies before the turn is written', async () => {
      const s = permissionable(peer());
      const engine = open(s.peer, { toolApproval: 'prompt' }); await engine.ready;
      expect(engine.adapter.host.descriptor().approvals).toBe('ask');
      const result = await engine.adapter.host.startCommand(withApprovals(engine, 'auto-edit')).terminal;
      expect(result.status).toBe('completed');
      expect(s.order).toEqual(['mode:acceptEdits:after-0-prompts']);
      expect(engine.adapter.host.descriptor().approvals).toBe('auto-edit');
      await engine.adapter.host.startCommand(withApprovals(engine, 'auto-edit', 'same')).terminal;
      expect(s.setPermissionMode).toHaveBeenCalledTimes(1);
    });

    it('maps every mode to a Claude permission mode and has no bypass mode', () => {
      expect(claudePermissionMode('ask')).toBe('default');
      expect(claudePermissionMode('auto-edit')).toBe('acceptEdits');
      expect(claudePermissionMode('read-only')).toBe('plan');
    });

    it('refuses the turn, writes nothing and stays usable when the connection cannot switch', async () => {
      const s = permissionable(peer(), false);
      const engine = open(s.peer, { toolApproval: 'prompt' }); await engine.ready;
      const refused = await engine.adapter.host.startCommand(withApprovals(engine, 'read-only')).terminal;
      expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'approvals_switch_refused', retryable: false,
        liftsWhen: expect.stringContaining('start a new Claude session') } });
      expect(s.peer.prompts).toHaveLength(0);
      expect(engine.adapter.host.descriptor().approvals).toBe('ask');
      const next = await engine.adapter.host.startCommand({ ...command(engine), commandId: 'cmd-after', turnId: 'owner-after' }).terminal;
      expect(next.status).toBe('completed');
    });
  });

  it('reports a turn that ended with no assistant content instead of completing it silently', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'error', scope: 'transport', code: 'claude_empty_turn',
    })));
  });

  it('reports a failing native result subtype with the reason the turn stopped', async () => {
    const p = peer({ holdResult: true });
    const servedAccountReader = vi.fn(async (_ownerId: string) => 'pool-claude-failure');
    const engine = open(p, { servedAccountReader }); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId,
      is_error: true, stop_reason: 'api_error', errors: ['no available account'] });
    await vi.waitFor(() => {
      expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
        type: 'error', scope: 'transport', code: 'claude_turn_failed',
        message: expect.stringContaining('no available account'),
      }));
      expect(engine.adapter.host.descriptor()).toMatchObject({
        lifecycle: 'waiting-for-owner', accountServed: 'pool-claude-failure',
      });
    });
    expect(servedAccountReader).toHaveBeenCalledWith('su-test');
  });

  it('does not report the owner interrupting a turn as a failed turn (P-032)', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal;
    expect(p.interrupt).toHaveBeenCalled();
    // Claude Code 2.1.289 ends an interrupted turn this way; pui printed the raw diagnostic.
    p.output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId, is_error: true,
      stop_reason: 'api_error', errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor()).toMatchObject({ lifecycle: 'waiting-for-owner' }));
    const errors = engine.adapter.host.recent.map(({ event }) => event).filter((event) => event.type === 'error');
    expect(errors).toEqual([]);
  });

  it('reports an API error carried on a success result instead of reading it as a reply', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId,
      is_error: true, stop_reason: null, result: 'Credit balance is too low' });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'error', scope: 'transport', code: 'claude_turn_failed',
      message: expect.stringContaining('Credit balance is too low'),
    })));
  });

  // pui-chat-first-ux P-025: the adapter also reported a failed result record,
  // so one refused turn produced two error events and PUI drew two failure
  // lines under the prompt (seen live on a weekly-limit refusal).
  it('reports a refused turn exactly once', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId,
      is_error: true, stop_reason: 'stop_sequence', result: "You've hit your weekly limit" });
    const errors = () => engine.adapter.host.recent.map(({ event }) => event).filter((event) => event.type === 'error');
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    await vi.waitFor(() => expect(errors().length).toBeGreaterThan(0));
    expect(errors()).toEqual([expect.objectContaining({
      code: 'claude_turn_failed', message: expect.stringContaining("You've hit your weekly limit"),
    })]);
  });

  it('does not report an answered turn as empty or failed', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event).filter((event) => event.type === 'error')).toEqual([]);
  });

  // A turn that NEVER ENDS emits no result frame, and both claude_turn_failed and
  // claude_empty_turn are nested under one — so neither can report it, and the owner
  // sees a silent hang. These guard the third detector that covers that case.
  describe('owner-turn stall watchdog', () => {
    // The scheduled registry keeps its default timer backend INERT under Vitest, so the
    // watchdog's managedSetInterval silently never arms on real timers and every
    // assertion below passes vacuously (measured: 2 red, 0 emitted). Fake timers restore
    // a seam the registry recognises (`timersAreFaked()`), and `shouldAdvanceTime` keeps
    // the clock moving with real time so the peer's stream I/O still makes progress.
    // Deliberately NOT fixed with `allowInTest` at the production call site: the tick
    // re-enters the adapter's host emission, which is the hazard that guard exists for.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it('reports an owner turn that stops producing frames without ever ending', async () => {
      const p = peer({ holdResult: true }); const engine = open(p, { turnStallTimeoutMs: 150 }); await engine.ready;
      await engine.adapter.host.startCommand(command(engine)).terminal;
      await vi.waitFor(() => expect(stalledReports(engine)).toHaveLength(1), { timeout: 2_000 });
      expect(stalledReports(engine)[0]).toEqual(expect.objectContaining({
        type: 'error', scope: 'transport', code: 'claude_turn_stalled', recoverable: true,
      }));
      // Observability only: the stall never fails the turn or ends the session.
      expect(engine.adapter.host.descriptor().lifecycle).not.toBe('failed');
      // Reported once per turn — a stall does not resolve on its own, so repeating
      // would bury the transcript without adding an observation.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(stalledReports(engine)).toHaveLength(1);
    });

    it('treats any stream frame as progress and reports only the silence that follows', async () => {
      const p = peer({ holdResult: true }); const engine = open(p, { turnStallTimeoutMs: 200 }); await engine.ready;
      await engine.adapter.host.startCommand(command(engine)).terminal;
      // A long tool call streams frames for far longer than the stall window without
      // producing a reply. That is progress, not a stall.
      for (let index = 0; index < 8; index += 1) {
        p.output.write({ type: 'system', subtype: 'status', status: 'requesting', session_id: nativeId, uuid: `keepalive-${index}` });
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      expect(stalledReports(engine)).toEqual([]);
      await vi.waitFor(() => expect(stalledReports(engine)).toHaveLength(1), { timeout: 2_000 });
    });

    it('does not report a stall after the terminal result while served-account provenance is pending', async () => {
      const p = peer();
      let resolveServedAccount!: (account: string) => void;
      const servedAccountRead = new Promise<string>((resolve) => { resolveServedAccount = resolve; });
      const servedAccountReader = vi.fn(() => servedAccountRead);
      const engine = open(p, { turnStallTimeoutMs: 60, servedAccountReader }); await engine.ready;
      const terminal = engine.adapter.host.startCommand(command(engine)).terminal;

      await vi.waitFor(() => expect(servedAccountReader).toHaveBeenCalledWith('su-test'));
      await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stalledReports(engine)).toEqual([]);

      resolveServedAccount('pool-claude-success');
      await expect(terminal).resolves.toMatchObject({ status: 'completed' });
      await vi.waitFor(() => expect(engine.adapter.host.descriptor()).toMatchObject({
        accountServed: 'pool-claude-success',
      }));
    });

    it('does not report a stall while an approval card waits for the owner, and restarts the clock after the answer', async () => {
      const p = peer({ holdResult: true }); const engine = open(p, { turnStallTimeoutMs: 150 }); await engine.ready;
      await engine.adapter.host.startCommand(command(engine)).terminal;
      // Claude sends no frames while it waits for a permission answer (P-028 probe 13
      // reported a false 114s stall under an open card).
      const permission = p.options()!.canUseTool!('Edit', { file_path: 'calc.js', old_string: 'a', new_string: 'b' }, {
        signal: new AbortController().signal, toolUseID: 'edit', requestId: 'edit-request', title: 'Edit calc.js?',
      });
      await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(stalledReports(engine)).toEqual([]);
      const [card] = openCards(engine);
      expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['yes'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
      await expect(permission).resolves.toMatchObject({ behavior: 'allow' });
      // The silence after the answer is measured from the answer, and still reported.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalledReports(engine)).toEqual([]);
      await vi.waitFor(() => expect(stalledReports(engine)).toHaveLength(1), { timeout: 2_000 });
    });

    it('stops watching a stalled turn once the engine is closed', async () => {
      const p = peer({ holdResult: true }); const engine = open(p, { turnStallTimeoutMs: 150 }); await engine.ready;
      await engine.adapter.host.startCommand(command(engine)).terminal;
      await engine.close();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(stalledReports(engine)).toEqual([]);
    });
  });

  it('queues an explicit follow-up on the same native session with one terminal receipt', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    const host = engine.adapter.host;
    expect(host.descriptor().capabilities.commands.queue?.state).toBe('supported');
    expect(host.descriptor().capabilities.commands.steer?.state).toBe('unsupported');
    await host.startCommand(command(engine)).terminal;
    const queued = { ...command(engine), type: 'queue' as const, commandId: 'queued-command', turnId: 'queued-turn', content: 'follow-up' };
    const dispatched = host.startCommand(queued);
    expect(host.startCommand(queued).replayed).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(p.prompts).toHaveLength(1);
    p.output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'first reply' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await expect(dispatched.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts.map(prompt => prompt.session_id)).toEqual([nativeId, nativeId]);
    expect(p.prompts[0].uuid).not.toBe(p.prompts[1].uuid);
    expect(p.prompts[1].message.content).toBe('follow-up');
    expect(host.recent.map(({ event }) => event).filter(event => event.type === 'command_result'
      && event.commandId === queued.commandId && event.status !== 'accepted')).toHaveLength(1);
  });

  it('holds an interrupt follow-up until both the native result and control acknowledgement settle', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    const host = engine.adapter.host;
    await host.startCommand(command(engine)).terminal;
    let acknowledge!: () => void;
    p.interrupt.mockImplementation(async () => {
      p.output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId, is_error: true, errors: ['interrupted tool'] });
      await new Promise<void>(resolve => { acknowledge = resolve; });
    });
    const stop = host.startCommand(command(engine, 'interrupt'));
    await vi.waitFor(() => expect(p.interrupt).toHaveBeenCalledOnce());
    const queued = host.startCommand({ ...command(engine), type: 'queue' as const, commandId: 'after-interrupt', turnId: 'follow-up', content: 'continue' });
    await vi.waitFor(() => expect(host.descriptor().lifecycle).toBe('waiting-for-owner'));
    // Drain the in-process delivery continuations before asserting absence.
    // The lifecycle event can precede a wrongly unblocked follow-up's input.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(p.prompts).toHaveLength(1);
    acknowledge();
    await expect(stop.terminal).resolves.toMatchObject({ status: 'completed' });
    await expect(queued.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(p.prompts.map(prompt => prompt.session_id)).toEqual([nativeId, nativeId]);
    expect(host.recent.some(({ event }) => event.type === 'error' && event.code === 'claude_turn_failed')).toBe(false);
  });

  it('refuses queued delivery after an uncertain interrupt acknowledgement', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    const host = engine.adapter.host;
    await host.startCommand(command(engine)).terminal;
    p.interrupt.mockRejectedValue(new Error('control pipe closed'));
    await expect(host.startCommand(command(engine, 'interrupt')).terminal).resolves.toMatchObject({ status: 'refused' });
    const follow = host.startCommand({ ...command(engine), type: 'queue' as const, commandId: 'uncertain-follow', turnId: 'follow', content: 'continue' });
    p.output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId, is_error: true, errors: ['interrupted'] });
    await expect(follow.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false } });
    expect(p.prompts).toHaveLength(1);
  });

  it('keeps overlapping accepted turns queued until the current reply completes', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const second = engine.adapter.host.startCommand({ ...command(engine), commandId: 'second-command', turnId: 'second-turn', content: 'second' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(p.prompts.filter((message) => message.shouldQuery !== false)).toHaveLength(1);
    p.output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'first reply' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    expect((await second.terminal).status).toBe('completed');
    expect(p.prompts.at(-1)?.message.content).toBe('second');
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({ type: 'transcript', turnId: 'owner-turn-1', content: 'first reply' }));
  });

  it('streams a long native response before canonical replay or result completion without duplicating text', async () => {
    const p = peer({ streamOnly: true });
    const engine = open(p, { deliveryTimeoutMs: 100 });
    await engine.ready;
    expect((await engine.adapter.host.startCommand(command(engine)).terminal).status).toBe('completed');
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.role === 'assistant')).toBe(false);
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'long reply' } } });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'delta', turnId: 'owner-turn-1', content: 'long reply',
    })));
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.phase === 'completed')).toBe(false);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 } });
    // The canonical block is authoritative, including a tail missing from the
    // partial feed. It must finish the existing segment, not append a duplicate.
    p.output.write({ type: 'assistant', session_id: nativeId, message: { id: 'native-long-reply', content: [{ type: 'text', text: 'long reply finished' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'assistant', turnId: 'owner-turn-1', content: 'long reply finished',
    }));
    expect(engine.adapter.host.recent.map(({ event }) => event)
      .filter((event) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'completed'))
      .toHaveLength(1);
    expect(engine.adapter.host.recent.flatMap(({ event }) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'delta' ? [event.content] : []).join(''))
      .toBe('long reply finished');
  });

  it('reconciles separate text blocks sharing a native message id and preserves the intervening tool', async () => {
    const p = peer({ streamOnly: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const partial = (event: unknown, parent: string | null = null) => p.output.write({
      type: 'stream_event', session_id: nativeId, parent_tool_use_id: parent, event,
    });
    const canonical = (content: unknown[]) => p.output.write({ type: 'assistant', session_id: nativeId,
      message: { id: 'native-long-reply', content } });
    for (const index of [0, 2]) {
      partial({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      partial({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Same text.' } });
      await vi.waitFor(() => expect(engine.adapter.host.recent.filter(({ event }) => event.type === 'transcript'
        && event.phase === 'delta' && event.role === 'assistant')).toHaveLength(index === 0 ? 1 : 2));
      canonical([{ type: 'text', text: 'Same text.' }]);
      partial({ type: 'content_block_stop', index });
      if (index === 0) {
        canonical([{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: 'README.md' } }]);
        // A child response must not change which root block is being streamed.
        partial({ type: 'message_start', message: { id: 'child-message', role: 'assistant' } }, 'read-tool');
        partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child text' } }, 'read-tool');
      }
    }
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    const events = engine.adapter.host.recent.map(({ event }) => event);
    expect(events.filter((event) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'completed'))
      .toEqual([0, 2].map(() => expect.objectContaining({ content: 'Same text.', turnId: 'owner-turn-1' })));
    expect(events.filter((event) => event.type === 'tool' && event.phase === 'started')).toEqual([
      expect.objectContaining({ callId: 'read-tool', name: 'Read', turnId: 'owner-turn-1' }),
    ]);
    expect(events.some((event) => event.type === 'transcript' && 'content' in event && event.content === 'child text')).toBe(false);
  });

  it('preserves an interrupted partial response and clears its reconciliation state for the next owner turn', async () => {
    const p = peer({ streamOnly: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unfinished' } } });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'delta', content: 'unfinished',
    })));
    await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal;
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'completed', turnId: 'owner-turn-1', content: 'unfinished',
    }));
    await engine.adapter.host.startCommand({ ...command(engine), commandId: 'next-command', turnId: 'next-turn' }).terminal;
    p.output.write({ type: 'assistant', session_id: nativeId, message: { id: 'native-long-reply', content: [{ type: 'text', text: 'fresh reply' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'completed', turnId: 'next-turn', content: 'fresh reply',
    }));
  });

  it('does not acknowledge owner input from a nested agent stream', async () => {
    const p = peer({ streamOnly: true, streamParent: 'other-agent-call' });
    const engine = open(p, { deliveryTimeoutMs: 20 });
    await engine.ready;
    expect(await engine.adapter.host.startCommand(command(engine)).terminal).toMatchObject({
      status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false },
    });
  });

  it('acknowledges a same-session SDK requesting status while one owner input is active', async () => {
    const p = peer({ noAck: true, statusAck: true, statusUuid: 'sdk-status-event-id' });
    const engine = open(p, { deliveryTimeoutMs: 20 });
    await engine.ready;
    expect(await engine.adapter.host.startCommand(command(engine)).terminal).toMatchObject({
      status: 'completed',
    });
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'system', content: 'requesting', turnId: 'owner-turn-1',
    }));
  });

  it('does not acknowledge an SDK requesting status that precedes owner input', async () => {
    const p = peer({ noAck: true, statusBeforeInput: true });
    const engine = open(p, { deliveryTimeoutMs: 20 });
    await engine.ready;
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(
      expect.objectContaining({ type: 'transcript', role: 'system', content: 'requesting' }),
    ));
    expect(await engine.adapter.host.startCommand(command(engine)).terminal).toMatchObject({
      status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false },
    });
  });

  it('waits for a workspace-bound PUI answer before returning a Claude question result', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const input = { questions: [{ question: 'Which destination?', header: 'Destination', multiSelect: false,
      options: [{ label: 'Here', description: 'Current directory' }, { label: 'There', description: 'Another directory' }] }],
      answers: { 'Which destination?': 'forged answer' } };
    p.output.write({ type: 'assistant', session_id: nativeId, message: { content: [
      { type: 'tool_use', id: 'native-question', name: 'AskUserQuestion', input },
    ] } });
    const answer = p.options()!.canUseTool!('AskUserQuestion', input, {
      signal: new AbortController().signal, toolUseID: 'native-question', requestId: 'question-request',
    });
    let settled = false; void answer.then(() => { settled = true; });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const card = openCards(engine)[0];
    expect(card.correlationId).not.toBe('native-question');
    expect(settled).toBe(false);
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'wrong' }).ok).toBe(false);
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which destination?': 'There' } } });
    expect(openCards(engine)).toHaveLength(0);
    expect(engine.adapter.host.recent.filter(({ event }) => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
  });

  it('connects native MCP form callbacks to validated private cards and cancels them on runtime close', async () => {
    const p = peer({ holdResult: true }), engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const signal = new AbortController().signal;
    const invoke = (requestId: string) => p.options()!.onElicitation!({ mode: 'form', serverName: 'example',
      message: 'Credentials', requestedSchema: { type: 'object', properties: {
        password: { type: 'string', minLength: 8, writeOnly: true },
      }, required: ['password'] } }, { signal, requestId });
    const first = invoke('first');
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const card = openCards(engine)[0];
    expect(card.presentation).toMatchObject({ kind: 'text', sensitive: true });
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { value: 'bad' }, expectedWorkspaceId: 'workspace' }).ok).toBe(false);
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { value: 'private-answer' }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(first).resolves.toEqual({ action: 'accept', content: { password: 'private-answer' } });
    expect(JSON.stringify(engine.adapter.host.recent)).not.toContain('private-answer');
    const cancelled = invoke('second');
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    await engine.close();
    await expect(cancelled).resolves.toEqual({ action: 'cancel' });
  });

  it('turns a deferred tools_invoke AskUserQuestion into a PUI choice card', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const pending = p.options()!.canUseTool!('mcp__papercusp-su__tools_invoke', {
      name: 'AskUserQuestion', args: { questions: [{ question: 'Keep or change?', multiSelect: false,
        options: [{ label: 'Keep' }, { label: 'Change' }] }] },
    }, { signal: new AbortController().signal, toolUseID: 'wrapped-question', requestId: 'wrapped-request' });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const [card] = openCards(engine);
    expect(card).toMatchObject({ prompt: 'Keep or change?', presentation: { kind: 'radio' } });
    expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny',
      message: expect.stringContaining('"Keep or change?":"Change"') });
    expect(openCards(engine)).toHaveLength(0);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
  });

  it('returns a native denial when a PUI permission is declined and cancels questions on interrupt', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const canUseTool = p.options()!.canUseTool!;
    const permission = canUseTool('Bash', { command: 'touch approved.txt' }, {
      signal: new AbortController().signal, toolUseID: 'permission', requestId: 'permission-request', title: 'Create approved.txt?',
    });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const card = openCards(engine)[0];
    // D-028 approval options have stable ids: yes / always / no.
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['no'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    const questions = canUseTool('AskUserQuestion', { questions: [
      { question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Second?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] }, { signal: new AbortController().signal, toolUseID: 'questions', requestId: 'two-questions' });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal;
    await expect(questions).resolves.toMatchObject({ behavior: 'deny' });
    expect(openCards(engine)).toHaveLength(0);
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'card' && event.phase === 'opened' && event.card.prompt === 'Second?')).toBe(false);
  });

  it('allows only server-advertised read-only SU tools without a card (D-021)', async () => {
    const p = peer({ holdResult: true, suTools: [
      { name: 'work_items_get', annotations: { readOnly: true } },
      { name: 'orders_disposition', annotations: { readOnly: false } },
      { name: 'capability_read', annotations: { readOnly: true } },
    ] });
    const engine = open(p, { toolApproval: 'prompt' }); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const canUseTool = p.options()!.canUseTool!;
    const request = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: `${id}-request` });
    await expect(canUseTool('mcp__papercusp-su__work_items_get', { id: 'WI-1' }, request('read')))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { id: 'WI-1' } });
    expect(openCards(engine)).toHaveLength(0);
    // A user ask rule outranks the annotation; writes and host reads still ask.
    for (const [name, id] of [['mcp__papercusp-su__work_items_get', 'ask-rule'], ['mcp__papercusp-su__work_items_comment', 'write'],
      ['mcp__papercusp-su__capability_read', 'host-read'], ['mcp__other__work_items_get', 'other-server']] as const) {
      void canUseTool(name, {}, { ...request(id), ...(id === 'ask-rule' ? { matchedAskRule: { source: 'userSettings', toolName: name } } : {}) });
      await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
      const card = openCards(engine)[0];
      // The card names the tool in its human display form (su-session-approval-display),
      // in its D-028 title above the question.
      expect(card.approval?.title).toContain(humanToolName(name));
      resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['no'] }, expectedWorkspaceId: 'workspace' });
      await vi.waitFor(() => expect(openCards(engine)).toHaveLength(0));
    }
  });

  it('auto-allows only the advertised directive disposition write, and keeps ask-rule matches gated (D-022)', async () => {
    const p = peer({ holdResult: true, suTools: [
      { name: 'orders_disposition', annotations: { readOnly: false } },
      { name: 'work_items_comment', annotations: { readOnly: false } },
    ] });
    const engine = open(p, { toolApproval: 'prompt' }); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const canUseTool = p.options()!.canUseTool!;
    const name = 'mcp__papercusp-su__orders_disposition';
    const input = { id: '#430', status: 'done', note: 'settle the captured owner directive' };
    const request = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: `${id}-request` });

    await expect(canUseTool(name, input, request('disposition')))
      .resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(openCards(engine)).toHaveLength(0);

    const otherWrite = canUseTool('mcp__papercusp-su__work_items_comment', {}, request('other-write'));
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const otherCard = openCards(engine)[0];
    expect(otherCard.approval?.title).toContain(humanToolName('mcp__papercusp-su__work_items_comment'));
    resolveCardResponse({ correlationId: otherCard.correlationId, action: 'submit', payload: { picks: ['no'] }, expectedWorkspaceId: 'workspace' });
    await expect(otherWrite).resolves.toMatchObject({ behavior: 'deny' });
    expect(openCards(engine)).toHaveLength(0);

    const forcedByAskRule = canUseTool(name, input, {
      ...request('ask-rule'), matchedAskRule: { source: 'userSettings', toolName: name },
    });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const askRuleCard = openCards(engine)[0];
    expect(askRuleCard.approval?.title).toContain(humanToolName(name));
    resolveCardResponse({ correlationId: askRuleCard.correlationId, action: 'submit', payload: { picks: ['yes'] }, expectedWorkspaceId: 'workspace' });
    await expect(forcedByAskRule).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('names the exact SU tools it will allow from the advertised annotations', () => {
    expect([...claudeReadOnlySuTools({ name: 'papercusp-su', tools: [
      { name: 'coord_whoami', annotations: { readOnly: true } },
      { name: 'mcp__papercusp-su__plans_get', annotations: { readOnly: true } },
      { name: 'tools_invoke', annotations: { readOnly: false } },
      { name: 'capability_read', annotations: { readOnly: true } },
      { name: 'unannotated' },
    ] })]).toEqual(['mcp__papercusp-su__coord_whoami', 'mcp__papercusp-su__plans_get']);
    expect(claudeReadOnlySuTools({ name: 'papercusp-su' }).size).toBe(0);
  });

  it('recognizes only a uniquely advertised writable owner directive disposition tool (D-022)', () => {
    expect([...claudeDirectiveDispositionSuTools({ name: 'papercusp-su', tools: [
      { name: 'orders_disposition', annotations: { readOnly: false } },
    ] })]).toEqual(['mcp__papercusp-su__orders_disposition']);
    expect([...claudeDirectiveDispositionSuTools({ name: 'papercusp-su', tools: [
      { name: 'mcp__papercusp-su__orders_disposition', annotations: { readOnly: false } },
    ] })]).toEqual(['mcp__papercusp-su__orders_disposition']);
    expect(claudeDirectiveDispositionSuTools({ name: 'other-server', tools: [
      { name: 'orders_disposition', annotations: { readOnly: false } },
    ] }).size).toBe(0);
    expect(claudeDirectiveDispositionSuTools({ name: 'papercusp-su', tools: [
      { name: 'orders_disposition' },
    ] }).size).toBe(0);
    expect(claudeDirectiveDispositionSuTools({ name: 'papercusp-su', tools: [
      { name: 'orders_disposition', annotations: { readOnly: false } },
      { name: 'mcp__papercusp-su__orders_disposition', annotations: { readOnly: false } },
    ] }).size).toBe(0);
  });

  it('cleans up a disconnected SU tool connection before ready', async () => {
    const p = peer({ connected: false }); const engine = open(p);
    await expect(engine.ready).rejects.toThrow('SU tool connection is failed');
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'lifecycle' && event.state === 'ready')).toBe(false);
  });

  it('waits for a pending MCP handshake instead of mistaking it for a missing server', async () => {
    const p = peer({ pendingMcp: true }); const engine = open(p, { startupTimeoutMs: 1_000 });
    expect(engine.adapter.host.descriptor().lifecycle).toBe('starting');
    await engine.ready;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
    expect(p.prompts).toHaveLength(0);
  });

  it.each([
    { config: { holdInit: true }, stage: 'SDK initialization' },
    { config: { holdMcp: true }, stage: 'SU tool connection' },
  ])('bounds a stalled SDK control handshake and names its step: $stage', async ({ config, stage }) => {
    const p = peer(config); const engine = open(p, { startupTimeoutMs: 20 });
    await expect(engine.ready).rejects.toThrow(`Claude startup timed out during ${stage}`);
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
  });

  it('names resume finalization when its hook stalls after transcript restore', async () => {
    const transcriptPath = join(dir, 'stalled-finalization.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: nativeId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }] } }) + '\n');
    const p = peer();
    const engine = open(p, { resume: true, startupTimeoutMs: 80,
      beforeReady: async () => { await new Promise(() => {}); },
    }, { ...runtime, transcriptPath });
    await expect(engine.ready).rejects.toThrow('Claude startup timed out during resume finalization');
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
  });

  it.each([{ identity: 'other-session' }, { cwd: '/another-project' }])('refuses the first owner turn when its native identity or project differs: %j', async (config) => {
    const p = peer(config); const engine = open(p); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result.status).toBe('refused');
    await engine.done;
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.role === 'assistant')).toBe(false);
  });

  it('converges an unexpected stream loss to a terminal failure', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    p.output.end(); await engine.done;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({ type: 'error', code: 'claude_stream_failed' }));
  });

  it('refuses an uncertain acknowledgement without retrying the owner text', async () => {
    const p = peer({ noAck: true }); const engine = open(p, { deliveryTimeoutMs: 20 }); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result).toMatchObject({ status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false } });
    expect(p.prompts.filter((message) => message.shouldQuery !== false)).toHaveLength(1);
  });

  it('uses structured interrupt and ends without a terminal control socket', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    expect((await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal).status).toBe('completed');
    expect(p.interrupt).toHaveBeenCalledOnce();
    expect((await engine.adapter.host.startCommand(command(engine, 'end')).terminal).status).toBe('completed');
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ended');
  });

  it('refuses a wrong bootstrap owner before constructing the engine', () => {
    const p = peer();
    expect(() => startClaudeSuEngine({ ...boot, envelopeEnv: { ...boot.envelopeEnv, PAPERCUSP_SID: 'other-owner' } }, binding, runtime, { agentChatId: 'chat', query: p.factory })).toThrow('durable SU identity');
    expect(p.options()).toBeUndefined();
  });
});

// Assembled at runtime, never written as a literal: this is a shared git-sync tree and
// both the secrets guard and the pot-git publish guard scan file TEXT, so a
// credential-shaped fixture committed here would refuse publishes from history.
const fixtureSecret = {
  anthropicKey: ['sk', 'ant', 'api03AAAABBBBCCCCDDDD'].join('-'),
  githubToken: ['ghp', 'AAAABBBBCCCCDDDDEEEE'].join('_'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'SflKxwRJSMeKKF2QT4fwpM'].join('.'),
  bearerToken: 'abcdefghijklmnopqrstuvwx',
  assignedValue: 'super-secret-value',
} as const;
const secretEnvName = ['ANTHROPIC', 'API', 'KEY'].join('_');

// psu-isolation D-002: the playbook splice delivers the project guide, so the
// SDK's project-memory auto-load must not send the same CLAUDE.md a second time.
describe('project guide delivered once', () => {
  const root = mkdtempSync(join(tmpdir(), 'pui-engine-guide-'));
  const cwd = join(root, 'repo', 'pkg');
  const guideFile = join(root, 'repo', 'CLAUDE.md');
  const guide = '# Repo guide\n\n' + 'Keep user-meaningful state in the URL.\n'.repeat(40);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(guideFile, guide);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const persona = 'SU persona and workspace scope.\n'.repeat(80);
  const spliced = `${persona}\n## Project guide — repo conventions\n\n> spliced\n\n${guide.trim()}\n`;

  it('excludes an ancestor guide whose whole text the prompt already carries', () => {
    const excluded = claudeMemoryFilesInPrompt(cwd, spliced);
    expect(excluded).toContain(guideFile);
    expect(excluded.every((file) => file.endsWith(join('repo', 'CLAUDE.md')))).toBe(true);
  });

  it('keeps auto-load when the prompt carries no copy or only a truncated one', () => {
    expect(claudeMemoryFilesInPrompt(cwd, persona)).toEqual([]);
    expect(claudeMemoryFilesInPrompt(cwd, spliced.slice(0, spliced.length - 80))).toEqual([]);
  });

  it('passes the excluded guide to the SDK as claudeMdExcludes', async () => {
    const p = peer();
    const guidePrompt = join(root, 'su.md');
    writeFileSync(guidePrompt, spliced);
    const engine = startClaudeSuEngine({ ...boot, cwd, promptFile: guidePrompt }, binding, runtime,
      { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300 });
    engines.push(engine);
    await engine.ready;
    const settings = p.options()?.settings;
    expect(typeof settings === 'object' ? settings.claudeMdExcludes : undefined).toContain(guideFile);
  });

  it('adds no exclusion for a prompt that does not splice the guide', async () => {
    const p = peer();
    const engine = startClaudeSuEngine({ ...boot, cwd }, binding, runtime,
      { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300 });
    engines.push(engine);
    await engine.ready;
    const settings = p.options()?.settings;
    expect(typeof settings === 'object' ? settings.claudeMdExcludes ?? [] : []).not.toContain(guideFile);
  });
});

// The engine used to DISCARD the child's stderr, so a child that refuses on that
// channel — a quota wall answers in ~5s in plain text and exits 1 — was invisible in
// every diagnostic, because all of them were derived from the protocol stream that
// child never reached (EI-22963885533180534). These cover the retention chain link by
// link: child stream -> bounded redacted tail -> the message an operator reads.
describe('child stderr retention', () => {
  it('retains what the child wrote to its own stderr, and keeps draining the pipe', async () => {
    const tail = createChildStderrTail();
    const stderr = new PassThrough();
    attachChildStderr(stderr, tail);
    stderr.write('Claude usage limit reached MARKER-QUOTA-WALL\n');
    await vi.waitFor(() => expect(tail.read()).toContain('MARKER-QUOTA-WALL'));
    // Retention REPLACES the old discard; it must not stop the drain, or a noisy
    // child deadlocks its own protocol pipes.
    expect(stderr.readableFlowing).toBe(true);
    expect(stderr.readableLength).toBe(0);
  });

  it('tolerates a child spawned without a stderr pipe', () => {
    expect(() => attachChildStderr(null, createChildStderrTail())).not.toThrow();
  });

  it('keeps the END of an oversized stderr stream, because a refusal arrives last', () => {
    const tail = createChildStderrTail();
    tail.append(`HEAD-MARKER${'x'.repeat(CHILD_STDERR_TAIL_LIMIT)}`);
    tail.append('TAIL-MARKER');
    const retained = tail.read();
    expect(retained).not.toContain('HEAD-MARKER');
    expect(retained).toContain('TAIL-MARKER');
    expect(retained.length).toBeLessThanOrEqual(CHILD_STDERR_TAIL_LIMIT);
  });

  it.each([
    ['an Anthropic key', `auth failed for ${fixtureSecret.anthropicKey}`, 'api03AAAABBBBCCCCDDDD'],
    ['a GitHub token', `auth failed for ${fixtureSecret.githubToken}`, 'AAAABBBBCCCCDDDDEEEE'],
    ['a JWT', `auth failed for ${fixtureSecret.jwt}`, 'SflKxwRJSMeKKF2QT4fwpM'],
    ['an Authorization header', `auth failed for Bearer ${fixtureSecret.bearerToken}`, fixtureSecret.bearerToken],
    ['a named secret assignment', `auth failed for ${secretEnvName}=${fixtureSecret.assignedValue}`, fixtureSecret.assignedValue],
  ])('redacts %s before the child stderr reaches a persisted event', (_label, line, secret) => {
    // The child inherits an env carrying OAuth tokens and PATs, and CLIs do echo
    // argv/env on some failures — so retention without redaction would persist them.
    const tail = createChildStderrTail();
    tail.append(line);
    const retained = tail.read();
    expect(retained).not.toContain(secret);
    // The surrounding diagnostic must survive, or redaction eats the message too.
    expect(retained).toContain('auth failed for');
    expect(redactChildStderr(line)).toBe(retained);
  });

  it('carries the child stderr onto a stall report and names its absence otherwise', () => {
    expect(formatStalledTurnMessage(120_000, 'MARKER-QUOTA-WALL'))
      .toBe('Claude produced no stream frame for 120s and this owner turn has not ended. Last child stderr: MARKER-QUOTA-WALL');
    const silent = formatStalledTurnMessage(90_000, '');
    expect(silent).toContain('90s');
    expect(silent).toContain('The child wrote nothing to stderr.');
    expect(silent).not.toContain('Last child stderr');
  });

  it('adds no suffix when the child wrote nothing, so a diagnostic never dangles', () => {
    expect(childStderrSuffix('')).toBe('');
    expect(childStderrSuffix('refused')).toBe(' Last child stderr: refused');
  });
});
