// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, handoffPathFor } from '../scripts/psu-pty-host.mjs';

async function control(sock: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let bytes = '';
    conn.setTimeout(3000, () => conn.destroy(new Error('fixture control timed out')));
    conn.once('error', reject);
    conn.on('data', data => { bytes += data.toString(); });
    conn.once('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    conn.once('connect', () => conn.end(JSON.stringify(message)));
  });
}

it('holds real PTY owner input and refuses wake/raw/recycle effects until exact caller thaw', async () => {
  const ownerId = `test-assume-host-${process.pid}-${Date.now()}`;
  const nativeId = 'disposable-native';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const signals = new EventEmitter();
  let output = '';
  const prepare = vi.fn(async () => null);
  const onReexec = vi.fn();
  const done = hostThroughPty({ command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',b=>process.stdout.write('INPUT:'+b.toString()+'\\n'));process.stdout.write('FIXTURE_READY\\n');setInterval(()=>{},1000)"],
    cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_SID: ownerId, PAPERCUSP_WORKSPACE: 'test-workspace',
      PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
    resolveRespawnNativeId: () => nativeId,
    identityAssume: { verify: async () => true, prepare }, onReexec,
    signalSource: signals, emitCompacted: () => null, onExit: () => {}, bridgeTty: false,
    io: { stdin, stdout: { isTTY: false, columns: 100, rows: 30,
      write(data: string) { output += data; return true; } } },
  });
  try {
    const meta = await vi.waitFor(() => {
      const value = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
      expect(output).toContain('FIXTURE_READY');
      expect(value.identityAssume?.version).toBe(1);
      return value;
    }, { timeout: 5000 });
    const request = { transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
      recoveryRef: 'carry-note:fixture', recoveryHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000,
      caller: { ownerId, workspaceId: 'test-workspace', nativeSessionId: nativeId,
        nativePid: meta.ptyPid, ...meta.identityAssume, childGeneration: meta.childGeneration } };
    const send = (action: string, value = request) => control(meta.sock, { v: 1, mode: 'identity-assume', ownerId, action, request: value });
    expect(await send('freeze')).toMatchObject({ ok: true, phase: 'frozen' });
    stdin.emit('data', Buffer.from('HELD_OWNER'));
    for (const mode of ['raw', 'turn', 'recycle', 'carry-respawn', 'hooks-observe', 'shutdown']) {
      expect(await control(meta.sock, { v: 1, mode, ownerId, data: 'MUST_NOT_RUN' }))
        .toMatchObject({ ok: false, reason: 'assume-caller-paused' });
    }
    expect(output).not.toContain('INPUT:HELD_OWNER');
    expect(await send('queue')).toMatchObject({ ok: true, phase: 'queued' });
    expect(await send('thaw', { ...request, recoveryHash: 'd'.repeat(64) })).toMatchObject({ ok: false });
    expect(prepare).not.toHaveBeenCalled(); // No native result/completion, so no target orders.
    expect(onReexec).not.toHaveBeenCalled();
    expect(await send('thaw')).toMatchObject({ ok: true, phase: 'released' });
    await vi.waitFor(() => expect(output).toContain('INPUT:HELD_OWNER'), { timeout: 3000 });
    // Simulate a caller that lost the first ACK. The same released custody is
    // acknowledged without replaying the owner input that was just drained.
    expect(await send('thaw')).toMatchObject({ ok: true, phase: 'released' });
    expect(output.split('INPUT:HELD_OWNER')).toHaveLength(2);
    expect(await send('freeze')).toMatchObject({ ok: false, reason: 'assume-replayed-transition' });
    const next = { ...request, transitionKey: `session-assume:${'e'.repeat(64)}` };
    expect(await send('freeze', next)).toMatchObject({ ok: true, phase: 'frozen' });
    expect(await send('thaw')).toMatchObject({ ok: false });
    expect(await send('thaw', next)).toMatchObject({ ok: true, phase: 'released' });
  } finally {
    signals.emit('SIGTERM');
    await done;
  }
}, 20_000);

it('waits for installed Codex to persist the tool result and complete before reaping the pinned caller', async () => {
  // This is a native delivery/completion fixture, not a production custody or
  // target-resume claim. The provider and accepted receipt are scripted; Codex,
  // its transcript, the managed PTY fence and caller-exit proof are real.
  const root = mkdtempSync('/tmp/psu-assume-native-');
  const codexHome = join(root, 'codex-home'); mkdirSync(codexHome);
  const ownerId = `test-assume-native-${randomUUID()}`;
  const signals = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const hosts: McpServer[] = [];
  const requests: Record<string, any>[] = [];
  const errors: string[] = [];
  let output = '', request: Record<string, any> | undefined;
  let issuedTool: Record<string, any> | undefined;
  let toolCalls = 0, toolIssued = false, completionRequested = false;
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
  const toolOutputs = (value: any): Array<Record<string, any>> => {
    if (typeof value === 'string') { try { return toolOutputs(JSON.parse(value)); } catch { return []; } }
    if (Array.isArray(value)) return value.flatMap(toolOutputs);
    if (!value || typeof value !== 'object') return [];
    if (String(value.type).endsWith('call_output')) return [value];
    return Object.values(value).flatMap(toolOutputs);
  };
  const transcript = () => {
    const files = readdirSync(join(codexHome, 'sessions'), { recursive: true })
      .map(String).filter(path => path.endsWith('.jsonl'));
    if (files.length !== 1) throw new Error(`Expected one isolated native transcript, found ${files.length}`);
    return readFileSync(join(codexHome, 'sessions', files[0]), 'utf8');
  };
  const nativeId = () => {
    try { return JSON.parse(transcript().split('\n')[0]).payload.id as string; }
    catch { return null; }
  };
  const prepare = vi.fn(async () => ({ code: 75, handoffPath: handoffPathFor(ownerId) }));
  const onReexec = vi.fn();
  const { codexCliResponsesBody, codexCliResponsesCompletionSse } = await import(
    '../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge');
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (req.url === '/mcp') {
        const host = new McpServer({ name: 'assume-native-fixture', version: '1' }); hosts.push(host);
        host.registerTool('assume_fixture', { inputSchema: {} }, async () => {
          toolCalls++;
          const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
          request = { transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
            recoveryRef: 'carry-note:fixture-native', recoveryHash: 'c'.repeat(64), expiresAt: Date.now() + 30_000,
            caller: { ownerId, workspaceId: 'test-workspace', nativeSessionId: nativeId(),
              nativePid: meta.ptyPid, ...meta.identityAssume, childGeneration: meta.childGeneration } };
          expect(request.caller.nativeSessionId).toBeTruthy();
          for (const action of ['freeze', 'queue']) expect(await control(meta.sock,
            { v: 1, mode: 'identity-assume', ownerId, action, request })).toMatchObject({ ok: true });
          return { content: [{ type: 'text', text: JSON.stringify({ transitionKey: request.transitionKey,
            preparationFingerprint: request.preparationHash, state: 'handoff-accepted', durable: true,
            preparation: { caller: { ...request.caller, backend: 'codex' } },
            recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } }) }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await host.connect(transport); await transport.handleRequest(req, res, body); return;
      }
      if (req.url !== '/v1/responses') { res.writeHead(200); res.end('{}'); return; }
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Interactive Codex also makes auxiliary Responses requests. Only the
      // continuation carrying THIS native tool result reaches our barrier.
      if (toolIssued && toolOutputs(body.input).some(item => item.call_id === 'native-assume')) {
        completionRequested = true;
        await completionGate;
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
          text: 'NATIVE_ASSUME_COMPLETED', inputTokens: 0, outputTokens: 0 })));
        return;
      }
      const tools = [...(body.tools ?? []), ...(body.input ?? []).flatMap(
        (item: Record<string, any>) => Array.isArray(item.tools) ? item.tools : [])];
      const namespace = tools.find(tool => tool.type === 'namespace' &&
        tool.tools?.some((entry: Record<string, any>) => entry.name === 'assume_fixture'));
      const direct = tools.find(tool => tool.type === 'function' && tool.name?.endsWith('__assume_fixture'));
      const executor = tools.find(tool => tool.type === 'namespace' &&
        tool.tools?.some((entry: Record<string, any>) => entry.type === 'custom' && entry.name === 'exec'));
      if (toolIssued || !namespace && !direct && !executor && !tools.some(tool => tool.type === 'tool_search')) {
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
          text: 'OFFLINE_AUXILIARY_RESPONSE', inputTokens: 0, outputTokens: 0 })));
        return;
      }
      const discovery = !namespace && !direct && !executor;
      if (discovery && requests.length > 3) throw new Error('Native fixture tool discovery did not converge');
      toolIssued = !discovery;
      const item = discovery ? { id: 'ts_assume', type: 'tool_search_call', execution: 'client',
        call_id: 'discover-assume', status: 'completed', arguments: { query: 'assume_fixture', limit: 1 } } :
        executor ? { id: 'fc_assume', type: 'custom_tool_call', namespace: executor.name,
          name: 'exec', call_id: 'native-assume', status: 'completed', input:
          "const tool = ALL_TOOLS.find(t => t.name.endsWith('__assume_fixture')); if (!tool) throw new Error('Fixture tool missing'); text(await tools[tool.name]({}));" } :
          { id: 'fc_assume', type: 'function_call', call_id: 'native-assume', status: 'completed',
            ...(namespace ? { namespace: namespace.name } : {}), name: direct?.name ?? 'assume_fixture', arguments: '{}' };
      const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
      issuedTool = item;
      res.end(event('response.output_item.added', { output_index: 0,
        item: { ...item, status: 'in_progress', ...(executor ? { input: '' } : { arguments: discovery ? {} : '' }) } }) +
        event('response.output_item.done', { output_index: 0, item }) +
        event('response.completed', { response: { ...codexCliResponsesBody({ model: 'gpt-6-sol',
          text: '', inputTokens: 0, outputTokens: 0 }), output: [item] } }));
    } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  let done: Promise<number> | undefined;
  try {
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1',
      () => resolve((server.address() as net.AddressInfo).port)));
    writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.fixture]\nurl = "http://127.0.0.1:${port}/mcp"\n`);
    const overrides = { model: 'gpt-6-sol', model_provider: 'assume_fixture',
      'model_providers.assume_fixture.name': 'Offline native assume fixture',
      'model_providers.assume_fixture.base_url': `http://127.0.0.1:${port}/v1`,
      'model_providers.assume_fixture.wire_api': 'responses',
      'model_providers.assume_fixture.requires_openai_auth': false,
      'model_providers.assume_fixture.supports_websockets': false,
      'model_providers.assume_fixture.request_max_retries': 0,
      'model_providers.assume_fixture.stream_max_retries': 0,
      'features.apps': false, 'features.hooks': false, web_search: 'disabled',
      [`projects.${JSON.stringify(root)}.trust_level`]: 'trusted' };
    done = hostThroughPty({ command: 'codex', args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
      ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
      'Exercise the offline native assume fixture.'], cwd: root, ownerId,
      env: hermeticEnv({ CODEX_HOME: codexHome, TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_SID: ownerId, PAPERCUSP_WORKSPACE: 'test-workspace', PAPERCUSP_PSU_REEXEC: '75',
        PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
      resolveRespawnNativeId: nativeId, identityAssume: { verify: async () => true, prepare }, onReexec,
      signalSource: signals, emitCompacted: () => null, onExit: () => {}, bridgeTty: false,
      io: { stdin, stdout: { isTTY: false, columns: 120, rows: 40,
        write(data: string) { output += data; return true; } } },
    });
    const diagnostics = () => JSON.stringify({ errors, toolCalls, requests: requests.length, issuedTool,
      toolOutputs: toolOutputs(requests.at(-1)?.input), output: output.slice(-2000) });
    await vi.waitFor(() => expect(completionRequested, diagnostics()).toBe(true), { timeout: 20_000 });
    expect(errors, diagnostics()).toEqual([]);
    expect(toolCalls, diagnostics()).toBe(1);
    expect(transcript()).toContain('handoff-accepted');
    expect(prepare).not.toHaveBeenCalled();
    expect(onReexec).not.toHaveBeenCalled();
    const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
    for (const mode of ['turn', 'raw', 'recycle', 'shutdown']) expect(await control(meta.sock,
      { v: 1, mode, ownerId, data: 'MUST_NOT_RUN' })).toMatchObject({ ok: false, reason: 'assume-caller-paused' });
    releaseCompletion();
    await vi.waitFor(() => expect(onReexec, diagnostics()).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(await done).toBe(75);
    expect(prepare).toHaveBeenCalledOnce();
    expect(onReexec.mock.calls[0][0]).toMatchObject({ mode: 'identity-assume', code: 75 });
    expect(() => process.kill(request!.caller.nativePid, 0)).toThrow();
    expect(transcript()).toContain('NATIVE_ASSUME_COMPLETED');
  } finally {
    releaseCompletion(); signals.emit('SIGTERM');
    await done;
    await Promise.all(hosts.map(host => host.close()));
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
