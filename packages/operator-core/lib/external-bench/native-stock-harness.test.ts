/** Stock factory lifecycle guards; provider transport and host IO are substituted,
 * so these tests never launch a model or spend inference budget. Physical native
 * confinement and SQL binding are covered by their integration suites. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { CONTAINER_CLAUDE_BIN_PATH, CONTAINER_CODEX_BIN_PATH, type DockerExecTarget } from './container-exec-target';
import type { RunAgentChatOptions, ChatEvent } from '../agent-chat-stream';
import type { CurrentStockBenchPorts, CurrentSuBenchOptions, CurrentSuBenchObservations } from './current-su';
import type { BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';

const h = vi.hoisted(() => ({
  home: '', owner: '', child: undefined as unknown as ChildProcess,
  run: vi.fn<(input: RunAgentChatOptions) => AsyncIterable<ChatEvent>>(),
  record: vi.fn(), reanchor: vi.fn(), bind: vi.fn(), end: vi.fn(), ingest: vi.fn(),
  managed: vi.fn(), kill: vi.fn(), host: vi.fn(), begin: vi.fn(), verifySession: vi.fn(), get: vi.fn(), sandbox: vi.fn(), common: vi.fn(),
}));
vi.mock('../adv-sessions', () => ({ recordAdvSession: h.record, reanchorAdvSessionNativeId: h.reanchor, markAdvSessionEnded: h.end }));
vi.mock('../task-manager/store', () => ({ bindLiveAgentSessionTasksToNativeSession: h.bind }));
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: h.managed }));
vi.mock('../agent-chat-stream', () => ({ runAgentChat: h.run }));
vi.mock('../interactive-usage/ingest-claude-transcripts', () => ({ ingestInteractiveUsage: h.ingest }));
vi.mock('../interactive-usage/ingest-adapters', () => ({ defaultAdapters: () => [{ name: 'codex' }, { name: 'claude' }] }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({ codexHomeForSessionKey: () => h.home, sessionClaudeConfigDir: () => h.home }));
vi.mock('@papercusp/orchestrator/fleet-srt-spawn', () => ({
  createScopedNativeSandboxSpawn: h.sandbox,
}));
vi.mock('./current-su', async (original) => ({
  ...await original<typeof import('./current-su')>(),
  requireCurrentBenchHostBinding: h.host,
  beginCurrentBenchNativeSession: h.begin,
  liveCurrentSuBenchPorts: h.common,
  // Exercise the actual factory's ports without replacing the separately tested
  // shared assignment verifier with a fabricated committed protocol.
  currentStockBenchHarnessDriver: (lifecycle: BenchHarnessOps, ports: CurrentStockBenchPorts) => ({ lifecycle, ports }),
}));

import { createCurrentStockBenchHarness } from './native-harness-runner';

let root: string;
let factories: Array<{ lifecycle: BenchHarnessOps; ports: CurrentStockBenchPorts }>;
const opts = (): CurrentSuBenchOptions => ({ workspaceId: 'private-stock', runId: 'PRIVATE', armId: 'baseline', seed: 1,
  agent: 'codex', model: 'frozen-model', effort: 'high', account: 'auto', preregistration: { preregHash: 'frozen', config: {} } });
const input = () => ({ handle: { slug: 'stock-private', featureId: 'native-assignment', worktreePath: root },
  task: { benchmark: 'swe-bench-pro' as const, instanceId: 't1', problemStatement: 'Public problem.', graderMeta: {} },
  context: { contextText: '\nShared permitted corpus.' } as Parameters<CurrentStockBenchPorts['launchNative']>[0]['context'] });
function factory(options = opts(), containerExec?: DockerExecTarget) {
  const observations = { nativeGateway: { baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }, containerExec } as CurrentSuBenchObservations;
  const ctx = { workspaceId: options.workspaceId, principal: { slug: 'authenticated-test-caller' } } as PapercuspUnifiedToolContext;
  const value = createCurrentStockBenchHarness(options, ctx, observations) as unknown as { lifecycle: BenchHarnessOps; ports: CurrentStockBenchPorts };
  factories.push(value); return value;
}
async function spawn(input: RunAgentChatOptions) {
  return input.spawnProcess!('codex', ['exec', '--json'], { cwd: root,
    env: { PATH: '/private/runtime', CODEX_HOME: h.home, OPENAI_API_KEY: 'HOST_SECRET_SENTINEL' } });
}
const terminal = () => Object.assign(h.child, { exitCode: 0 });

beforeEach(() => {
  vi.resetAllMocks(); root = mkdtempSync(join(tmpdir(), 'stock-factory-')); h.home = join(root, 'native-home'); factories = [];
  h.child = { exitCode: null, signalCode: null, kill: vi.fn(() => true) } as unknown as ChildProcess;
  h.host.mockReturnValue({ taskId: 't1' });
  h.common.mockReturnValue({ killTask: h.kill, getTask: h.get });
  h.begin.mockReturnValue(h.verifySession);
  h.record.mockImplementation(async (input) => { h.owner = input.coordOwnerId; return 1; });
  h.reanchor.mockImplementation(async () => ({ owner: h.owner, reanchored: true }));
  h.bind.mockResolvedValue(['stock-task']); h.end.mockResolvedValue(true); h.ingest.mockResolvedValue({});
  h.managed.mockResolvedValue({ child: h.child, taskId: 'stock-task' });
  h.sandbox.mockImplementation(() => (command: string, args: string[], options: unknown, spawn: Function) => spawn(command, args, options));
  h.get.mockImplementation(async () => ({ taskId: 'stock-task', workspaceId: 'private-stock', state: 'exited', exitCode: 0, detail: {} }));
  h.kill.mockImplementation(async () => { terminal(); return { ok: true, taskId: 'stock-task', action: 'kill' }; });
  h.run.mockImplementation(async function* (input) {
    await spawn(input); input.onNativeSession!('native-stock'); terminal();
    yield { type: 'result', finalText: 'done', costUsd: 0, tokensIn: 0, tokensOut: 0 };
  });
});
afterEach(async () => {
  await h.kill('stock-task');
  for (const value of factories) await value.lifecycle.teardown({ handle: input().handle, workspaceId: 'private-stock' }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

describe('current stock native factory', () => {
  it('enrolls Claude with its scoped transport and ingests only its retained projects', async () => {
    h.run.mockImplementation(async function* (options) {
      await options.spawnProcess!('claude', ['-p'], { cwd: h.home, env: { PATH: '/private/runtime', CLAUDE_CONFIG_DIR: h.home,
        ANTHROPIC_API_KEY: 'HOST_SECRET_SENTINEL', ANTHROPIC_AUTH_TOKEN: 'HOST_SECRET_SENTINEL', NODE_OPTIONS: 'HOST_INJECTION',
        DISABLE_INTERLEAVED_THINKING: '0', CLAUDE_CODE_MODEL_CAPABILITIES: 'mid_conv_system',
        CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '0' } });
      options.onNativeSession!('native-claude'); terminal();
      yield { type: 'result', finalText: 'done', costUsd: 0, tokensIn: 0, tokensOut: 0 };
    });
    const value = factory({ ...opts(), agent: 'claude' });
    await value.ports.launchNative(input()); await value.ports.getTask('stock-task');
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }));
    expect(h.run.mock.calls[0][0]).toMatchObject({ backend: 'claude-code', agentCmd: 'claude', isolateConfig: true,
      isolateDir: h.home, statelessGateway: { baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) } });
    expect(h.run.mock.calls[0][0].codexGateway).toBeUndefined();
    const env = h.managed.mock.calls[0][3].spawnOptions.env;
    expect(h.managed.mock.calls[0][3].spawnOptions.cwd).toBe(root);
    expect(h.sandbox).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
    expect(env).toMatchObject({ HOME: h.home, CLAUDE_CONFIG_DIR: h.home, XDG_CONFIG_HOME: join(h.home, '.config'),
      PAPERCUSP_AGENT: 'claude', ANTHROPIC_BASE_URL: 'http://127.0.0.1:32001', ANTHROPIC_AUTH_TOKEN: 'a'.repeat(64),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
      DISABLE_INTERLEAVED_THINKING: '1', CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system', DISABLE_AUTOUPDATER: '1' });
    for (const key of ['CODEX_HOME', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'OPENAI_API_KEY']) expect(env[key]).toBeUndefined();
    expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-claude', initialTaskId: 'stock-task' }), undefined);
    expect(h.ingest).toHaveBeenCalledWith(expect.objectContaining({ includeIsolationRoots: false,
      adapters: [expect.objectContaining({ name: 'claude', root: join(h.home, 'projects'), ownerId: h.owner, advSessionId: 1 })] }),
      { workspaceId: 'private-stock' });
    for (const path of ['.credentials.json', 'settings.json', 'CLAUDE.md']) expect(existsSync(join(h.home, path))).toBe(false);
  });

  it('relocates Claude into its container without Codex flags or host credentials', async () => {
    const homes = join(root, 'homes'); h.home = join(homes, 'claude-stock');
    const target: DockerExecTarget = { kind: 'docker-exec', containerId: 'private-claude', workdir: '/app', binPath: CONTAINER_CLAUDE_BIN_PATH,
      sessionRelocation: { sessionEnv: 'CLAUDE_CONFIG_DIR', roots: [{ hostRoot: homes, perTaskDir: join(root, 'task-homes') }] },
      originRewrites: [{ from: 'http://127.0.0.1:32001', to: 'http://papercusp-egress:8788' }] };
    const log = join(root, 'claude-exec.json');
    writeFileSync(join(root, 'docker'), `#!${process.execPath}
if (process.argv.includes('inspect')) {
  process.stdout.write(JSON.stringify({ id: 'c'.repeat(64), env: ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=0', 'PATH=/task/tools'] }));
} else require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), env: process.env}));
`, { mode: 0o755 });
    h.run.mockImplementation(async function* (options) {
      await options.spawnProcess!('claude', ['-p', '--model', 'frozen-model'], { cwd: h.home,
        env: { PATH: `${root}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: h.home, ANTHROPIC_API_KEY: 'HOST_SECRET_SENTINEL',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0', DISABLE_INTERLEAVED_THINKING: '0',
          CLAUDE_CODE_MODEL_CAPABILITIES: 'mid_conv_system', CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '0' } });
      options.onNativeSession!('native-claude'); terminal();
      yield { type: 'result', finalText: 'done', costUsd: 0, tokensIn: 0, tokensOut: 0 };
    });
    h.managed.mockImplementation(async (command, args, _meta, registration) => {
      const result = spawnSync(command, args, { ...registration.spawnOptions, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0); return { child: h.child, taskId: 'stock-task' };
    });
    const value = factory({ ...opts(), agent: 'claude' }, target);
    await value.ports.launchNative(input()); await value.ports.getTask('stock-task');
    const observed = JSON.parse(readFileSync(log, 'utf8'));
    expect(observed.args).toContain('c'.repeat(64));
    expect(observed.args.slice(-4)).toEqual([CONTAINER_CLAUDE_BIN_PATH, '-p', '--model', 'frozen-model']);
    expect(observed.args).not.toContain('--no-daemon'); expect(observed.args).not.toContain('ANTHROPIC_API_KEY');
    expect(observed.args).toContain('CLAUDE_CONFIG_DIR'); expect(observed.args).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(observed.args).toContain('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS');
    expect(observed.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(observed.args).toContain('CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK');
    expect(observed.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK).toBe('1');
    expect(observed.args).toContain('DISABLE_INTERLEAVED_THINKING');
    expect(observed.args).toContain('CLAUDE_CODE_MODEL_CAPABILITIES');
    expect(observed.env.DISABLE_INTERLEAVED_THINKING).toBe('1');
    expect(observed.env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe('-mid_conv_system');
    expect(observed.env.ANTHROPIC_BASE_URL).toBe('http://papercusp-egress:8788');
    expect(observed.env.ANTHROPIC_AUTH_TOKEN).toBe('a'.repeat(64));
    expect(lstatSync(h.home).isSymbolicLink()).toBe(true); expect(h.sandbox).not.toHaveBeenCalled();
  });

  it.each(['command', 'home', 'cwd'])('refuses a Claude transport conflict before managed spawn (%s)', async conflict => {
    h.run.mockImplementation(async function* (options) {
      await options.spawnProcess!(conflict === 'command' ? 'codex' : 'claude', [], {
        cwd: conflict === 'cwd' ? root : h.home,
        env: { CLAUDE_CONFIG_DIR: conflict === 'home' ? '/other' : h.home },
      });
    });
    await expect(factory({ ...opts(), agent: 'claude' }).ports.launchNative(input())).rejects.toThrow(/identity transport/);
    expect(h.managed).not.toHaveBeenCalled(); expect(h.end).toHaveBeenCalledOnce();
  });

  it('refuses a reused host allowance before enrolling another native session', async () => {
    h.begin.mockImplementation(() => { throw new Error('allowance already used'); });
    await expect(factory().ports.launchNative(input())).rejects.toThrow('allowance already used');
    expect(h.record).not.toHaveBeenCalled(); expect(h.managed).not.toHaveBeenCalled();
  });

  it('rechecks the allowance after enrollment before spawning the native process', async () => {
    h.verifySession.mockImplementation(() => { throw new Error('allowance retired'); });
    await expect(factory().ports.launchNative(input())).rejects.toThrow('allowance retired');
    expect(h.record).toHaveBeenCalledOnce(); expect(h.managed).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledOnce();
  });

  it('executes the container wrapper with a relocated clean home, rewritten gateway and task cwd', async () => {
    const homes = join(root, 'homes'), perTaskDir = join(root, 'task-homes');
    h.home = join(homes, '7');
    const target: DockerExecTarget = { kind: 'docker-exec', containerId: 'private-task-container',
      workdir: '/app', binPath: '/opt/papercusp/codex',
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir }] },
      originRewrites: [{ from: 'http://127.0.0.1:32001', to: 'http://papercusp-egress:8788' }] };
    const argvLog = join(root, 'argv.json');
    writeFileSync(join(root, 'docker'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    h.run.mockImplementation(async function* (options) {
      writeFileSync(join(h.home, 'config.toml'), 'base_url = "http://127.0.0.1:32001/v1"\n');
      await options.spawnProcess!('codex', ['exec', '--json'], { cwd: root,
        env: { PATH: `${root}:${process.env.PATH}`, CODEX_HOME: h.home, OPENAI_API_KEY: 'HOST_SECRET_SENTINEL' } });
      options.onNativeSession!('native-stock'); terminal();
      yield { type: 'result', finalText: 'done', costUsd: 0, tokensIn: 0, tokensOut: 0 };
    });
    h.managed.mockImplementation(async (command, args, _meta, registration) => {
      const result = spawnSync(command, args, { ...registration.spawnOptions, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return { child: h.child, taskId: 'stock-task' };
    });
    const value = factory(opts(), target);
    await value.ports.launchNative(input()); await value.ports.getTask('stock-task');
    expect(h.sandbox).not.toHaveBeenCalled();
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    expect(argv.slice(0, 4)).toEqual(['exec', '-i', '-w', '/app']);
    expect(argv.slice(argv.indexOf('private-task-container') + 1, -6)).toEqual([
      '/bin/sh', '-c', 'exec "$@"', expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(argv.slice(-6)).toEqual(['/opt/papercusp/codex', '-c',
      'projects={"/app"={trust_level="trusted"}}', '--no-daemon', 'exec', '--json']);
    expect(argv).not.toContain('OPENAI_API_KEY');
    expect(lstatSync(h.home).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(h.home, 'config.toml'), 'utf8')).toContain('http://papercusp-egress:8788/v1');
    for (const path of ['AGENTS.md', 'hooks.json', 'auth.json']) expect(existsSync(join(h.home, path))).toBe(false);
    expect(h.run.mock.calls[0][0].mcpConfig).toBeUndefined();
    expect(h.run.mock.calls[0][0].systemPromptText).toBeUndefined();
    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it.each(['codex', 'claude'] as const)('constructs stock %s Docker ports with the real shared lifecycle adapter', async agent => {
    const actual = await vi.importActual<typeof import('./current-su')>('./current-su');
    h.common.mockImplementationOnce(actual.liveCurrentSuBenchPorts);
    const target: DockerExecTarget = { kind: 'docker-exec', containerId: 'private-task', workdir: '/app',
      binPath: agent === 'claude' ? CONTAINER_CLAUDE_BIN_PATH : CONTAINER_CODEX_BIN_PATH,
      sessionRelocation: { sessionEnv: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        roots: [{ hostRoot: '/tmp/homes', perTaskDir: '/tmp/task-homes' }] }, originRewrites: [] };
    expect(() => factory({ ...opts(), agent }, target)).not.toThrow();
    expect(h.record).not.toHaveBeenCalled(); expect(h.managed).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'] as const)('refuses mismatched stock %s container controls before enrollment', agent => {
    const target: DockerExecTarget = { kind: 'docker-exec', containerId: 'private-task', workdir: '/app',
      binPath: agent === 'claude' ? CONTAINER_CLAUDE_BIN_PATH : CONTAINER_CODEX_BIN_PATH,
      sessionRelocation: { sessionEnv: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        roots: [{ hostRoot: '/tmp/homes', perTaskDir: '/tmp/task-homes' }] }, originRewrites: [] };
    const options = { ...opts(), agent };
    expect(() => factory(options, { ...target, workdir: '/other' })).toThrow(/Stock native container/);
    expect(() => factory(options, { ...target, binPath: agent === 'claude' ? CONTAINER_CODEX_BIN_PATH : CONTAINER_CLAUDE_BIN_PATH })).toThrow(/Stock native container/);
    expect(() => factory(options, { ...target, sessionRelocation: { ...target.sessionRelocation!, sessionEnv: agent === 'claude' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR' } })).toThrow(/Stock native container/);
    expect(h.record).not.toHaveBeenCalled(); expect(h.managed).not.toHaveBeenCalled();
  });

  it('refuses stock targets carrying host hooks or lacking the clean-home rewrite before enrollment', () => {
    const target: DockerExecTarget = { kind: 'docker-exec', containerId: 'private-task', workdir: '/app', binPath: CONTAINER_CODEX_BIN_PATH,
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: '/tmp/homes', perTaskDir: '/tmp/task-homes' }] },
      originRewrites: [] };
    expect(() => factory(opts(), { ...target, hookBridge: { url: 'http://egress:9081', recordDir: '/tmp/private-records' } })).toThrow(/without host hooks/);
    expect(() => factory(opts(), { ...target, originRewrites: undefined })).toThrow(/gateway rewrite/);
    expect(h.record).not.toHaveBeenCalled(); expect(h.managed).not.toHaveBeenCalled();
  });

  it('binds exactly the enrolled task and ingests only its retained native home', async () => {
    const value = factory();
    expect(await value.ports.launchNative(input())).toMatchObject({ tasks: [{ taskId: 'stock-task' }] });
    await value.ports.getTask('stock-task');
    expect(h.bind).toHaveBeenCalledWith({ workspaceId: 'private-stock', coordOwnerId: h.owner,
      sessionId: 'native-stock', initialTaskId: 'stock-task' }, undefined);
    const config = h.run.mock.calls[0][0];
    expect(config).toMatchObject({ backend: 'codex', model: 'frozen-model:high', isolateConfig: true, isolateDir: h.home });
    expect(config.promptText).toContain('Public problem.'); expect(config.promptText).toContain('Shared permitted corpus.');
    expect(config.promptText).not.toContain('work_items:');
    expect(h.managed.mock.calls[0][3]).toMatchObject({ requireRegistration: true, workspaceId: 'private-stock',
      spawnOptions: { env: { HOME: h.home, CODEX_HOME: h.home, PAPERCUSP_SID: h.owner } } });
    expect(h.managed.mock.calls[0][3].spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(h.ingest).toHaveBeenCalledWith(expect.objectContaining({ includeIsolationRoots: false,
      adapters: [expect.objectContaining({ name: 'codex', root: join(h.home, 'sessions'), ownerId: h.owner, advSessionId: 1 })] }),
      { workspaceId: 'private-stock' });
  });

  it.each([{ receipt: [] }, { receipt: ['other-task'] }, { receipt: ['stock-task', 'other-task'] }, { receipt: null }])('retains an invalid task-binding receipt as a generation error ($receipt)', async ({ receipt }) => {
    h.bind.mockResolvedValue(receipt); const value = factory(); await value.ports.launchNative(input());
    expect(await value.ports.getTask('stock-task')).toMatchObject({ detail: { nativeStreamError: 'Stock native task registry binding failed.' } });
  });

  it('joins an in-flight native link before ending the session even when the stream throws', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = new Promise<void>(resolve => { entered = resolve; });
    h.reanchor.mockImplementation(async () => { entered(); await gate; return { owner: h.owner }; });
    h.run.mockImplementation(async function* (options) {
      await spawn(options); options.onNativeSession!('native-stock'); terminal(); throw new Error('stream failed');
    });
    const value = factory(); await value.ports.launchNative(input()); await binding;
    await new Promise<void>(resolve => setImmediate(resolve));
    const endedBeforeBinding = h.end.mock.calls.length > 0;
    release(); await value.ports.getTask('stock-task');
    expect(endedBeforeBinding).toBe(false);
    expect(h.bind).toHaveBeenCalledOnce(); expect(h.end).toHaveBeenCalledOnce();
    expect(await value.ports.getTask('stock-task')).toMatchObject({ detail: { nativeStreamError: 'stream failed' } });
  });

  it('preserves sanitized native stderr explaining an early CLI failure', async () => {
    h.run.mockImplementation(async function* (options) {
      await spawn(options); terminal();
      yield { type: 'error', message: 'codex exited 1', stderr: 'native boot refused: missing configuration' };
    });
    const value = factory(); await value.ports.launchNative(input());
    expect(await value.ports.getTask('stock-task')).toMatchObject({ detail: {
      nativeStreamError: 'codex exited 1\nnative boot refused: missing configuration',
    } });
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('retires the owned task rather than only its launcher handle when a live link is refused', async () => {
    let stopped!: () => void; const stopping = new Promise<void>(resolve => { stopped = resolve; });
    h.kill.mockImplementation(async () => { terminal(); stopped(); return { ok: true, taskId: 'stock-task', action: 'kill' }; });
    h.bind.mockResolvedValue([]);
    h.run.mockImplementation(async function* (options) {
      await spawn(options); options.onNativeSession!('native-stock'); await stopping;
      yield { type: 'result', finalText: '', costUsd: 0, tokensIn: 0, tokensOut: 0 };
    });
    const value = factory(); await value.ports.launchNative(input());
    try { await expect.poll(() => h.kill.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0); }
    finally { await h.kill('stock-task'); }
    expect(await value.ports.getTask('stock-task')).toMatchObject({ detail: { nativeStreamError: 'Stock native task registry binding failed.' } });
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  it('refuses cancellation and failed enrollment before a native fork', async () => {
    const cancel = new AbortController(); cancel.abort(); const value = factory({ ...opts(), signal: cancel.signal });
    await expect(value.ports.launchNative(input())).rejects.toThrow('cancelled before process creation');
    expect(h.managed).not.toHaveBeenCalled(); expect(h.end).toHaveBeenCalled();
    h.record.mockResolvedValue(null);
    await expect(factory().ports.launchNative(input())).rejects.toThrow('session enrollment failed');
    expect(h.managed).not.toHaveBeenCalled();
  });
});
