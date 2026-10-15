import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelRequest } from './model-port';
import { createOperatorOwnedLoopPort } from './headless-invoke';

afterEach(() => vi.unstubAllEnvs());

describe('createOperatorOwnedLoopPort', () => {
  const invocation = (runId = 'run-host', signal?: AbortSignal) => ({
    role: 'worker', prompt: 'do work', model: 'openrouter/vendor/model', runId,
    featureId: null, chunkId: null, workspaceId: 'caller-workspace', harnessSlug: 'papercusp',
    projectDir: '/repo', stateDir: '/repo/.papercusp', cwd: '/repo', signal,
    emit: vi.fn(),
  });

  it.each(['workspaceId', 'cwd', 'projectDir'])('refuses a changed customer %s before binding', async key => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    const bind = vi.fn();
    const input = { ...invocation(), [key]: 'foreign' };
    const host = createOperatorOwnedLoopPort({ customerExecution: {
      workspaceId: 'caller-workspace', projectDir: '/repo', bind }, flushTelemetry: async () => {} });
    expect(await host.invoke(input)).toEqual({ exitCode: 1, stderr: 'owned-loop customer execution host unavailable' });
    expect(bind).not.toHaveBeenCalled(); expect(input.emit).not.toHaveBeenCalled();
  });

  it('runs exclusively on the trusted customer ports and preserves channel cancellation', async () => {
    vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'vm-release');
    const lifetime = new AbortController();
    const caller = new AbortController();
    const requests: ModelRequest[] = [];
    const modelPort: ModelPort = { async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'private result' };
      yield { type: 'stop', reason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    } };
    const bind = vi.fn(async () => ({ modelPort, tools: [], signal: lifetime.signal }));
    const ambient = vi.fn();
    const host = createOperatorOwnedLoopPort({ customerExecution: {
      workspaceId: 'caller-workspace', projectDir: '/repo', bind },
    modelPort: ambient, tools: [], flushTelemetry: async () => {} });
    expect(await host.invoke(invocation('customer-run', caller.signal))).toEqual({ exitCode: 0 });
    expect(bind).toHaveBeenCalledExactlyOnceWith(caller.signal);
    expect(ambient).not.toHaveBeenCalled();
    expect(requests[0].signal?.aborted).toBe(false);
    lifetime.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    expect(await host.invoke(invocation())).toEqual({ exitCode: 130, stderr: 'owned-loop turn aborted' });
    expect(requests).toHaveLength(1);
  });

  it.each(['throws', 'model', 'tools', 'signal'])('refuses an invalid customer %s without ambient fallback', async mode => {
    const bind = vi.fn(async () => {
      if (mode === 'throws') throw new Error('private credential');
      return { modelPort: { stream: vi.fn() }, tools: [], signal: new AbortController().signal,
        [mode === 'model' ? 'modelPort' : mode]: null } as never;
    });
    const ambient = vi.fn(); const input = invocation();
    const host = createOperatorOwnedLoopPort({ customerExecution: {
      workspaceId: 'caller-workspace', projectDir: '/repo', bind }, modelPort: ambient, flushTelemetry: async () => {} });
    expect(await host.invoke(input)).toEqual({ exitCode: 1, stderr: 'owned-loop customer execution host unavailable' });
    expect(ambient).not.toHaveBeenCalled(); expect(input.emit).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'VM release', env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' } },
    { name: 'VM release with TCP opt-out', env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release', PAPERCUSP_LOOPBACK_PEER_UID_POLICY: 'off' } },
    { name: 'unenrolled customer host', env: { PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/customer-workspace' } },
    { name: 'multi-account service', env: { PAPERCUSP_LOOPBACK_PEER_UID_POLICY: 'service-only' } },
  ])('refuses $name before resolving a model factory or emitting native events', async ({ env }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const factory = vi.fn(() => ({ stream: vi.fn() }) as unknown as ModelPort);
    const flushTelemetry = vi.fn(async () => {});
    const input = invocation();
    expect(await createOperatorOwnedLoopPort({ modelPort: factory, tools: [], flushTelemetry }).invoke(input))
      .toEqual({ exitCode: 1, stderr: 'owned-loop customer execution host unavailable' });
    expect(factory).not.toHaveBeenCalled();
    expect(input.emit).not.toHaveBeenCalled();
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });

  it('awaits a fresh host port per invocation and snapshots caller attribution', async () => {
    let release!: (port: ModelPort) => void;
    const factory = vi.fn(() => new Promise<ModelPort>(resolve => { release = resolve; }));
    const requests: ModelRequest[] = [];
    const modelPort: ModelPort = { async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'stop', reason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    } };
    const flushTelemetry = vi.fn(async () => {});
    const host = createOperatorOwnedLoopPort({ modelPort: factory, tools: [], flushTelemetry });
    const input = invocation();
    const first = host.invoke(input);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(requests).toEqual([]);
    input.prompt = 'mutated'; input.model = 'claude-sonnet-4-6'; input.runId = 'mutated';
    release(modelPort);
    expect(await first).toEqual({ exitCode: 0 });
    expect(requests[0]).toMatchObject({ model: 'openrouter/vendor/model', ownerId: 'run-host',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'do work' }] }] });
    factory.mockResolvedValue(modelPort);
    expect(await host.invoke(invocation('run-next'))).toEqual({ exitCode: 0 });
    expect(factory.mock.calls).toEqual([[undefined], [undefined]]);
    expect(flushTelemetry).toHaveBeenCalledTimes(2);
  });

  it.each(['throws', 'missing', 'malformed'] as const)('refuses a %s host port without ambient fallback or private error text', async mode => {
    const factory = vi.fn(async () => {
      if (mode === 'throws') throw new Error('secret=private tenant=private');
      return (mode === 'missing' ? undefined : { stream: 'invalid' }) as unknown as ModelPort;
    });
    const flushTelemetry = vi.fn(async () => {});
    const input = invocation();
    expect(await createOperatorOwnedLoopPort({ modelPort: factory, tools: [], flushTelemetry }).invoke(input))
      .toEqual({ exitCode: 1, stderr: 'owned-loop model host unavailable' });
    expect(input.emit).not.toHaveBeenCalled();
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'during'] as const)('cancels %s host creation without dispatch and drains a late rejection', async timing => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const factory = vi.fn(() => new Promise<ModelPort>((_resolve, fail) => { reject = fail; }));
    const flushTelemetry = vi.fn(async () => {});
    const input = invocation('run-abort', controller.signal);
    if (timing === 'before') controller.abort();
    const pending = createOperatorOwnedLoopPort({ modelPort: factory, tools: [], flushTelemetry }).invoke(input);
    if (timing === 'during') {
      await vi.waitFor(() => expect(factory).toHaveBeenCalledExactlyOnceWith(controller.signal));
      controller.abort();
    }
    expect(await pending).toEqual({ exitCode: 130, stderr: 'owned-loop turn aborted' });
    expect(input.emit).not.toHaveBeenCalled();
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
    if (timing === 'before') expect(factory).not.toHaveBeenCalled();
    else { reject(new Error('late private host failure')); await Promise.resolve(); }
  });

  it.each(['provider-error', 'capture-error', 'capture-abort'])('awaits trusted capture in a headless %s turn and retains failure', async mode => {
    const controller = new AbortController();
    const request = { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-headless' } };
    let pulled = false;
    let closed = false;
    const modelPort: ModelPort = { async *stream() { try {
      yield { type: 'provider_request', request, servedAccount: 'local-account' };
      pulled = true;
      yield { type: 'error', message: 'provider unavailable' };
    } finally { closed = true; } } };
    const capture = vi.fn(async () => {
      if (mode !== 'provider-error') {
        if (mode === 'capture-abort') controller.abort();
        throw new Error('durable capture unavailable');
      }
    });
    const flushTelemetry = vi.fn(async () => {});
    const events: unknown[] = [];
    const outcome = await createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry,
      onProviderRequest: capture }).invoke({ role: 'worker', prompt: 'do work', model: 'openrouter:vendor/model',
      runId: 'run-capture', featureId: null, chunkId: null, workspaceId: 'ws', harnessSlug: 'papercusp',
      projectDir: '/repo', stateDir: '/repo/.papercusp', cwd: '/repo', signal: controller.signal,
      emit: event => events.push(event) });
    expect(capture).toHaveBeenCalledExactlyOnceWith({ stepIndex: 0, request, servedAccount: 'local-account' },
      { runId: 'run-capture', workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain(mode === 'provider-error' ? 'provider unavailable' : 'durable capture unavailable');
    expect(pulled).toBe(mode === 'provider-error');
    expect(closed).toBe(true);
    expect(events.some(event => (event as { type: string }).type === 'step_end')).toBe(false);
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });
  it('runs one prompt through the owned ModelPort and emits bounded native events', async () => {
    const requests: ModelRequest[] = [];
    const modelPort: ModelPort = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'headless result' };
        yield {
          type: 'stop',
          reason: 'end_turn',
          usage: { inputTokens: 14, outputTokens: 4, costUsd: 0.002 },
        };
      },
    };
    const flushTelemetry = vi.fn(async () => {});
    const port = createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry });
    const events: unknown[] = [];

    const outcome = await port.invoke({
      role: 'worker',
      prompt: '# WORKER\n\nImplement the chunk.',
      model: 'claude-sonnet-4-6',
      runId: 'run-010',
      featureId: 'F-010',
      chunkId: 'ck-010',
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      projectDir: '/repo',
      stateDir: '/repo/.papercusp',
      cwd: '/repo/.papercusp/worktrees/F-010',
      emit: (event) => events.push(event),
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      system: '',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '# WORKER\n\nImplement the chunk.' }],
      }],
    });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'step_start',
      'text_delta',
      'step_end',
      'done',
    ]);
    const done = events.at(-1) as Record<string, unknown>;
    expect(done).toMatchObject({
      type: 'done',
      finalText: 'headless result',
      usage: { inputTokens: 14, outputTokens: 4, costUsd: 0.002 },
      stepCount: 1,
    });
    expect(done.messages).toBeUndefined();
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });

  it('maps an in-loop error to a non-zero one-shot outcome', async () => {
    const modelPort: ModelPort = {
      async *stream() {
        yield { type: 'error', message: 'provider unavailable' };
      },
    };
    const events: unknown[] = [];
    const flushTelemetry = vi.fn(async () => {});
    const outcome = await createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry }).invoke({
      role: 'worker',
      prompt: 'do work',
      model: 'claude-sonnet-4-6',
      runId: 'run-error',
      featureId: null,
      chunkId: null,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      projectDir: '/repo',
      stateDir: '/repo/.papercusp',
      cwd: '/repo',
      emit: (event) => events.push(event),
    });

    expect(outcome).toEqual({ exitCode: 1, stderr: 'provider unavailable' });
    expect(events.some((event) => (event as { type?: string }).type === 'error')).toBe(true);
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });
});
