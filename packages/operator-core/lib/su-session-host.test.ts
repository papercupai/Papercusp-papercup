import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCapabilities,
  type SuSessionCommand,
  type SuSessionDescriptor,
  type SuSessionEvent,
} from '@papercusp/chat-protocol';
import {
  SuSessionHost,
  SuSessionHostError,
  _resetSuSessionHostsForTest,
  createSuSessionEventResponse,
  registerSuSessionHost,
  type SuSessionCommandExecutor,
} from './su-session-host';
import type { SuSessionCommandStore } from './su-session-commands';
import { _resetSuClientLeaseForTest, type SuClientLeaseStore } from './su-session-client-lease';

vi.mock('./endpoint-route/telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// P-009: every event stream renews the session's durable client lease. Unit
// tests record those grants instead of writing adv_sessions rows.
const leaseGrants: number[] = [];
const leaseStore: SuClientLeaseStore = {
  grant: async (advSessionId) => { leaseGrants.push(advSessionId); },
  renew: async () => undefined,
  detach: async () => true,
  expired: async () => [],
};
_resetSuClientLeaseForTest(leaseStore);

const supported = { state: 'supported', implementation: 'native' } as const;
const hostSupported = { state: 'supported', implementation: 'host' } as const;
const capabilities: SuSessionCapabilities = {
  commands: {
    owner_turn: supported,
    interrupt: supported,
    resume: supported,
    fork: { state: 'unsupported', reason: 'fake backend has no fork' },
    focus: hostSupported,
    end: supported,
  },
  features: {
    'tool-events': supported,
    'interactive-cards': supported,
    'reasoning-stream': supported,
    usage: supported,
    compaction: supported,
    approvals: supported,
    context: supported,
    modes: supported,
  },
};

function descriptor(): SuSessionDescriptor<'claude'> {
  return {
    identity: {
      agentChatId: 'chat-1',
      advSessionId: 41,
      backend: 'claude',
      nativeSessionId: 'claude-native-1',
      ownerId: 'su-owner',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
    },
    lifecycle: 'starting',
    runtimeGeneration: 1,
    role: 'su',
    model: 'claude-opus',
    accountServed: null,
    accountRoute: 'default',
    carry: 'warm',
    modes: ['auto'],
    capabilities,
    backendExtension: {
      backend: 'claude',
      configDir: '/tmp/claude-su',
      configDirSource: 'live-process',
    },
  };
}

function command(type: SuSessionCommand<'claude'>['type'], commandId = `command-${type}`): SuSessionCommand<'claude'> {
  const base = {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId,
    issuedAt: '2026-08-28T00:00:00.000Z',
    target: descriptor().identity,
  };
  switch (type) {
    case 'owner_turn':
      return { ...base, type, turnId: 'turn-1', content: 'Continue.' };
    case 'interrupt':
      return { ...base, type, reason: 'owner interrupt' };
    case 'resume':
      return { ...base, type, cause: 'pui-restart' };
    case 'fork':
      return { ...base, type, fromSequence: 3 };
    case 'focus':
      return { ...base, type };
    case 'end':
      return { ...base, type, reason: 'owner ended' };
  }
}

function eventTypes(host: SuSessionHost<'claude'>): string[] {
  return host.recent.map(({ event }) => event.type);
}

describe('descriptor persistence under streaming output', () => {
  it('keeps one write in flight and persists the latest descriptor after a burst', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const persist = vi.fn(async (_snapshot: SuSessionDescriptor<'claude'>) => {
      if (persist.mock.calls.length === 1) await held;
      return true;
    });
    const host = new SuSessionHost({ descriptor: descriptor(), persistDescriptor: persist });
    try {
      await Promise.resolve();
      expect(persist).toHaveBeenCalledTimes(1);
      host.transition('running');
      for (let i = 0; i < 100; i++) {
        host.emit({
          type: 'transcript', role: 'assistant', phase: 'delta', channel: 'text',
          content: String(i), turnId: 'turn-1',
        });
      }
      host.transition('waiting-for-owner');
      host.transition('ended');
      expect(host.recent.at(-1)?.event).toMatchObject({ type: 'lifecycle', state: 'ended' });
      expect(persist).toHaveBeenCalledTimes(1);
      let settled = false;
      const barrier = host.persistDescriptorNow().then((ok) => { settled = true; return ok; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await expect(barrier).resolves.toBe(true);
      expect(persist.mock.calls.map(([snapshot]) => snapshot.lifecycle)).toEqual(['starting', 'ended']);
    } finally {
      release();
      host.dispose();
    }
  });

  it('does not rewrite an unchanged descriptor for transcript or receipt events', async () => {
    const persist = vi.fn(async (_snapshot: SuSessionDescriptor<'claude'>) => true);
    const host = new SuSessionHost({ descriptor: descriptor(), persistDescriptor: persist });
    try {
      await host.persistDescriptorNow();
      persist.mockClear();
      host.emit({
        type: 'transcript', role: 'assistant', phase: 'delta', channel: 'text',
        content: 'hello', turnId: 'turn-1',
      });
      host.emit({ type: 'command_result', commandId: 'cmd', commandType: 'owner_turn', status: 'accepted' });
      host.emit({ type: 'session', descriptor: host.descriptor() });
      await Promise.resolve();
      expect(persist).not.toHaveBeenCalled();
    } finally { host.dispose(); }
  });

  it('reports a failed durability barrier and permits an explicit retry', async () => {
    const persist = vi.fn(async (_snapshot: SuSessionDescriptor<'claude'>) => true)
      .mockRejectedValueOnce(new Error('database unavailable'));
    const host = new SuSessionHost({ descriptor: descriptor(), persistDescriptor: persist });
    try {
      await expect(host.persistDescriptorNow()).resolves.toBe(false);
      await expect(host.persistDescriptorNow()).resolves.toBe(true);
    } finally { host.dispose(); }
  });
});

describe('runtime-assigned native identity', () => {
  it('reattaches a restored host on its existing stream with the same identity and receipts', async () => {
    const saved = { ...descriptor(), lifecycle: 'ended' as const };
    const host = new SuSessionHost({ descriptor: saved });
    let ready = false;
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    try {
      const before = host.recent.at(-1)!.id;
      const resumed = { ...saved, lifecycle: 'starting' as const, runtimeGeneration: 2 };
      expect(() => host.attachRuntime({ descriptor: saved, executeCommand: execute })).toThrow('advance the runtime generation');
      expect(() => host.attachRuntime({ descriptor: { ...resumed, identity: { ...saved.identity, ownerId: 'another-owner' } }, executeCommand: execute })).toThrow('preserve identity');
      host.attachRuntime({ descriptor: resumed, executeCommand: execute, runtimeReady: () => ready });
      expect(host.snapshot().executorAttached).toBe(false);
      expect(host.descriptor()).toEqual(resumed);
      expect(host.snapshot().runtimeReconciliation).toEqual({ action: 'reattach', reason: 'runtime_replacement', stalePid: false });
      expect(host.recentSince(before)[0].event).toMatchObject({ type: 'session', session: saved.identity });
      ready = true;
      host.transition('ready');
      const dispatch = await host.acceptCommand(command('focus'));
      expect(await dispatch.terminal).toMatchObject({ status: 'completed' });
      expect(execute).toHaveBeenCalledOnce();
      expect((await host.acceptCommand(command('focus'))).replayed).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(() => host.attachRuntime({ descriptor: { ...resumed, runtimeGeneration: 3 }, executeCommand: execute })).toThrow('without an executor');
    } finally { host.dispose(); }
  });

  it('keeps initialization unready and binds only the first native id', () => {
    const initial = descriptor();
    initial.identity.nativeSessionId = '';
    const host = new SuSessionHost({ descriptor: initial, executeCommand: async () => ({ status: 'completed' }) });
    try {
      expect(host.snapshot()).toMatchObject({ executorAttached: false, streamReady: false });
      host.materializeNativeSessionId('native-from-protocol');
      expect(host.descriptor().identity).toEqual({ ...initial.identity, nativeSessionId: 'native-from-protocol' });
      expect(host.recent.at(-1)?.event).toMatchObject({
        type: 'session', session: { nativeSessionId: 'native-from-protocol' },
        descriptor: { identity: { nativeSessionId: 'native-from-protocol' } },
      });
      expect(() => host.materializeNativeSessionId('another-thread')).toThrow('only be bound once');
    } finally { host.dispose(); }
  });

  it('refuses native identity changes after initialization and through ordinary session events', () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    try {
      expect(() => host.emit({ type: 'session', descriptor: {
        ...descriptor(), identity: { ...descriptor().identity, nativeSessionId: 'wrong-thread' },
      } })).toThrow('cannot replace');
      host.transition('ready');
      expect(() => host.materializeNativeSessionId('wrong-thread')).toThrow('only be bound once');
    } finally { host.dispose(); }
  });
});

describe('durable SU owner-turn acceptance', () => {
  const hosts: SuSessionHost<'claude'>[] = [];
  afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });
  function readyHost(execute = vi.fn(async () => ({ status: 'completed' as const }))) {
    const host = new SuSessionHost({ descriptor: { ...descriptor(), lifecycle: 'ready' }, executeCommand: execute });
    hosts.push(host);
    return host;
  }

  it('publishes no acceptance and invokes no engine before the reservation commits', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = readyHost(execute);
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    const store: SuSessionCommandStore = {
      reserve: async (input, fingerprint) => {
        await committed;
        return { created: true, receipt: { command: input, fingerprint, acceptedAt: input.issuedAt } };
      },
      finish: vi.fn(async () => {}),
    };
    const pending = host.acceptCommand(command('owner_turn'), store);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(host.recent.some(({ event }) => event.type === 'command_result')).toBe(false);
    commit();
    const accepted = await pending;
    expect(accepted.accepted?.status).toBe('accepted');
    expect((await accepted.terminal).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), expect.any(String), { status: 'completed' });
  });

  it('fails closed on persistence failure and permits a safe retry before acceptance', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = readyHost(execute);
    const store: SuSessionCommandStore = {
      reserve: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockImplementation(async (input, fingerprint) => ({
        created: true, receipt: { command: input, fingerprint, acceptedAt: input.issuedAt },
      })),
      finish: vi.fn(async () => {}),
    };
    await expect(host.acceptCommand(command('owner_turn'), store)).rejects.toThrow('database unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect(host.recent.some(({ event }) => event.type === 'command_result')).toBe(false);
    const retried = await host.acceptCommand(command('owner_turn'), store);
    expect((await retried.terminal).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports uncertain prior delivery without executing the saved turn a second time', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = readyHost(execute);
    const store: SuSessionCommandStore = {
      reserve: async (input, fingerprint) => ({
        created: false, receipt: { command: input, fingerprint, acceptedAt: input.issuedAt },
      }),
      finish: vi.fn(async () => {}),
    };
    const replay = await host.acceptCommand(command('owner_turn'), store);
    expect(replay.replayed).toBe(true);
    expect(replay.accepted?.status).toBe('accepted');
    expect(await replay.terminal).toMatchObject({
      status: 'refused', refusal: { code: 'command_delivery_unknown', retryable: false },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('refuses a turn retryably while the engine compacts, then runs that same turn exactly once after compaction ends', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = readyHost(execute);
    const store: SuSessionCommandStore = {
      reserve: vi.fn(async (input, fingerprint) => ({
        created: true, receipt: { command: input, fingerprint, acceptedAt: input.issuedAt },
      })),
      finish: vi.fn(async () => {}),
    };
    host.transition('running', 'owner turn in flight');
    host.transition('compacting', 'native context compacting');
    const during = await host.acceptCommand(command('owner_turn'), store);
    expect(during.accepted).toBeNull();
    expect(await during.terminal).toMatchObject({
      status: 'refused', refusal: { code: 'session_not_ready', retryable: true },
    });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    // Both adapters leave 'compacting' when the native turn completes.
    host.transition('waiting-for-owner', 'native turn completed');
    const after = await host.acceptCommand(command('owner_turn'), store);
    expect(after.replayed).toBe(false);
    expect(after.accepted?.status).toBe('accepted');
    expect((await after.terminal).status).toBe('completed');
    expect(store.reserve).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('requires the executor as well as a stream and checks identity before reserving', async () => {
    const store: SuSessionCommandStore = { reserve: vi.fn(), finish: vi.fn() };
    const host = new SuSessionHost({ descriptor: { ...descriptor(), lifecycle: 'ready' } });
    hosts.push(host);
    expect(host.snapshot()).toMatchObject({ executorAttached: false, streamReady: true });
    const refused = await host.acceptCommand(command('owner_turn'), store);
    expect(await refused.terminal).toMatchObject({ refusal: { code: 'session_not_ready' } });
    const wrong = command('owner_turn', 'wrong-target');
    wrong.target = { ...wrong.target, workspaceId: 'another-workspace' };
    expect(await (await readyHost().acceptCommand(wrong, store)).terminal).toMatchObject({
      refusal: { code: 'target_mismatch' },
    });
    expect(store.reserve).not.toHaveBeenCalled();
  });

  // pui-chat-first-ux P-026 / D-025: an owner turn may carry the model to run
  // it on; omitted keeps the current one, but a present one must be a spec.
  it('P-026: refuses an owner turn whose model is present but empty, before reserving', async () => {
    const store: SuSessionCommandStore = { reserve: vi.fn(), finish: vi.fn() };
    for (const model of ['', '   ', 42]) {
      await expect(readyHost().acceptCommand({ ...command('owner_turn'), model } as never, store))
        .rejects.toMatchObject({ code: 'invalid_command' });
    }
    expect(store.reserve).not.toHaveBeenCalled();
  });

  it('P-026: publishes the model an engine switched to, once', () => {
    const host = readyHost();
    const before = eventTypes(host).length;
    expect(host.updateModel('claude-sonnet-4-5:high')).not.toBeNull();
    expect(host.descriptor().model).toBe('claude-sonnet-4-5:high');
    expect(host.updateModel('claude-sonnet-4-5:high')).toBeNull();
    expect(eventTypes(host).slice(before)).toEqual(['session']);
  });

  it('P-026: persists the owner-selected model separately from later native model observations', async () => {
    const persist = vi.fn(async (_snapshot: SuSessionDescriptor<'claude'>) => true);
    const host = new SuSessionHost({ descriptor: descriptor(), persistDescriptor: persist });
    try {
      host.updateModel('claude-haiku-4-5:high');
      host.emit({ type: 'session', descriptor: { ...host.descriptor(), model: 'claude-haiku-4-5' } });
      await expect(host.persistDescriptorNow()).resolves.toBe(true);

      expect(host.descriptor()).toMatchObject({
        model: 'claude-haiku-4-5',
        ownerSelectedModel: 'claude-haiku-4-5:high',
      });
      expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({
        model: 'claude-haiku-4-5',
        ownerSelectedModel: 'claude-haiku-4-5:high',
      });
    } finally { host.dispose(); }
  });

  // pui-chat-first-ux P-027 / D-026: an owner turn may carry an approvals mode.
  it('D-026: refuses an owner turn whose approvals mode is unknown, before reserving', async () => {
    const store: SuSessionCommandStore = { reserve: vi.fn(), finish: vi.fn() };
    for (const approvals of ['', 'full-access', 'bypassPermissions', 3]) {
      await expect(readyHost().acceptCommand({ ...command('owner_turn'), approvals } as never, store))
        .rejects.toMatchObject({ code: 'invalid_command' });
    }
    expect(store.reserve).not.toHaveBeenCalled();
  });

  it('D-026: publishes the approvals mode an engine switched to, once', () => {
    const host = readyHost();
    const before = eventTypes(host).length;
    expect(host.updateApprovals('read-only')).not.toBeNull();
    expect(host.descriptor().approvals).toBe('read-only');
    expect(host.updateApprovals('read-only')).toBeNull();
    expect(eventTypes(host).slice(before)).toEqual(['session']);
  });

  // pui-chat-first-ux P-029 / D-031: usage and plan ride the descriptor.
  it('D-031: merges usage into the descriptor, keeps unreported fields, and emits only on change', () => {
    const host = readyHost();
    const before = eventTypes(host).length;
    expect(host.updateUsage({ contextTokens: 1200, contextWindow: 200_000 })).not.toBeNull();
    expect(host.updateUsage({ costUsd: 0.25 })).not.toBeNull();
    expect(host.descriptor().usage).toEqual({ contextTokens: 1200, contextWindow: 200_000, costUsd: 0.25 });
    // A repeat of known values, and values that are not measurements, change nothing.
    expect(host.updateUsage({ contextTokens: 1200 })).toBeNull();
    expect(host.updateUsage({ contextTokens: -1, costUsd: Number.NaN } as never)).toBeNull();
    expect(host.descriptor().usage).toEqual({ contextTokens: 1200, contextWindow: 200_000, costUsd: 0.25 });
    expect(eventTypes(host).slice(before)).toEqual(['session', 'session']);
  });

  it('D-031: replaces the plan list and emits only when it changed', () => {
    const host = readyHost();
    const before = eventTypes(host).length;
    const plan = [
      { text: 'Read the file', status: 'completed' as const },
      { text: 'Write the fix', status: 'in_progress' as const },
    ];
    expect(host.updatePlan(plan)).not.toBeNull();
    expect(host.descriptor().plan).toEqual(plan);
    expect(host.updatePlan(plan.map((item) => ({ ...item })))).toBeNull();
    expect(host.updatePlan([{ text: 'Write the fix', status: 'completed' }])).not.toBeNull();
    expect(host.descriptor().plan).toEqual([{ text: 'Write the fix', status: 'completed' }]);
    expect(host.updatePlan([])).not.toBeNull();
    expect(host.descriptor().plan).toEqual([]);
    expect(eventTypes(host).slice(before)).toEqual(['session', 'session', 'session']);
  });

  it('WI-10006652: publishes the engine model catalog and emits only when it changed', () => {
    const host = readyHost();
    const before = eventTypes(host).length;
    const models = [
      { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', efforts: ['low', 'high'] },
      { id: ' ', label: 'Unnamed' },
    ];
    expect(host.updateModels(models)).not.toBeNull();
    // A row with no id is not something a client could ever send back.
    expect(host.descriptor().models).toEqual([models[0]]);
    expect(host.updateModels([{ ...models[0] }])).toBeNull();
    // An empty answer keeps the last catalog rather than blanking /model.
    expect(host.updateModels([])).toBeNull();
    expect(host.descriptor().models).toEqual([models[0]]);
    expect(eventTypes(host).slice(before)).toEqual(['session']);
  });
});

afterEach(() => {
  _resetSuSessionHostsForTest();
  vi.restoreAllMocks();
});

describe('SuSessionHost', () => {
  it('orders command acknowledgements, transcript/tool/card events, and typed backend metadata', async () => {
    const executor: SuSessionCommandExecutor<'claude'> = async (input, context) => {
      if (input.type === 'owner_turn') {
        context.emit({
          type: 'transcript',
          phase: 'delta',
          turnId: input.turnId,
          role: 'assistant',
          channel: 'text',
          content: 'Working',
        });
        context.emit({
          type: 'tool',
          phase: 'completed',
          turnId: input.turnId,
          callId: 'tool-1',
          name: 'coord:orient',
          output: { ok: true },
          isError: false,
        });
        context.emit({
          type: 'card',
          phase: 'opened',
          turnId: input.turnId,
          card: { correlationId: 'card-1', createdAt: 1, prompt: 'Choose' },
        });
        context.emit({
          type: 'backend',
          extension: {
            backend: 'claude',
            configDir: '/tmp/replaced',
            configDirSource: 'runtime-reattach',
          },
        });
      }
      return { status: 'completed' };
    };
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: executor });

    const dispatch = host.startCommand(command('owner_turn'));
    expect(dispatch.accepted).toMatchObject({ status: 'accepted', sequence: 2 });
    await expect(dispatch.terminal).resolves.toMatchObject({
      status: 'completed',
      sequence: 7,
    });

    expect(eventTypes(host)).toEqual([
      'session',
      'command_result',
      'transcript',
      'tool',
      'card',
      'backend',
      'command_result',
    ]);
    expect(host.recent.map(({ id, event }) => [id, event.sequence])).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((sequence) => [sequence, sequence]),
    );
    expect(host.descriptor().backendExtension).toEqual({
      backend: 'claude',
      configDir: '/tmp/replaced',
      configDirSource: 'runtime-reattach',
    });
  });

  it('executes one command id once and replays the same accepted/terminal result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => {
      await gate;
      return { status: 'completed' };
    });
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const input = command('owner_turn', 'same-id');

    const first = host.startCommand(input);
    const duplicate = host.startCommand(JSON.parse(JSON.stringify(input)));
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.accepted).toBe(first.accepted);
    expect(duplicate.terminal).toBe(first.terminal);
    release();
    await first.terminal;

    const lateDuplicate = host.startCommand(input);
    await lateDuplicate.terminal;
    expect(lateDuplicate.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      host.recent.filter(({ event }) => event.type === 'command_result' && event.commandId === 'same-id'),
    ).toHaveLength(2);
  });

  it('rejects a command-id collision without re-running the original command', async () => {
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => ({
      status: 'completed',
    }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    await host.startCommand(command('owner_turn', 'collision')).terminal;
    const changed = {
      ...command('owner_turn', 'collision'),
      content: 'Different content',
    };

    expect(() => host.startCommand(changed)).toThrowError(SuSessionHostError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.recent.at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'command_id_conflict',
    });
  });

  it('converges a crashed runtime once and visibly refuses later commands', async () => {
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => ({
      status: 'completed',
    }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });

    host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
    host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
    expect(host.descriptor().lifecycle).toBe('failed');
    expect(host.recent.filter(({ event }) => event.type === 'lifecycle' && event.state === 'failed')).toHaveLength(1);

    const refused = host.startCommand(command('owner_turn', 'after-crash'));
    expect(refused.accepted).toBeNull();
    await expect(refused.terminal).resolves.toMatchObject({
      status: 'refused',
      refusal: { code: 'session_terminal', retryable: false },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('ignores a runtime exit reported after the host was disposed', () => {
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: async () => ({ status: 'completed' }) });
    host.dispose();
    // An engine's cleanup can land after a reopen or session end disposed its
    // host; that must not throw out of the engine's teardown.
    expect(host.reconcileRuntimeExit({ expected: true })).toBeNull();
    expect(host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' })).toBeNull();
  });

  it('settles an in-flight command quietly when its host is disposed before the engine returns', async () => {
    // The HTTP door returns on acceptance and never awaits `terminal`, so a host
    // disposed mid-command (startup exit, reopen, end) must not leave that promise
    // to reject unobserved: it surfaced as an unhandled rejection in the operator.
    const settle: Array<(outcome: 'completed' | 'throw') => void> = [];
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(() => new Promise((resolve, reject) => {
      settle.push((outcome) => (outcome === 'completed'
        ? resolve({ status: 'completed' })
        : reject(new Error('engine exited during startup'))));
    }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const completes = host.startCommand(command('owner_turn', 'disposed-completes'));
    const throws = host.startCommand(command('owner_turn', 'disposed-throws'));
    expect(completes.accepted).not.toBeNull();
    expect(throws.accepted).not.toBeNull();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      host.dispose('engine exited during startup');
      settle[0]!('completed');
      settle[1]!('throw');
      for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    // A caller that does await the terminal still learns the host is gone.
    await expect(completes.terminal).rejects.toMatchObject({ code: 'host_disposed' });
    await expect(throws.terminal).rejects.toMatchObject({ code: 'host_disposed' });
  });

  it('releases a crashed runtime\'s executor so a replacement attaches to the same host', () => {
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => ({ status: 'completed' }));
    const saved = descriptor();
    const host = new SuSessionHost({ descriptor: saved, executeCommand: execute });
    const replacement = { ...saved, lifecycle: 'starting' as const, runtimeGeneration: saved.runtimeGeneration + 1 };
    // A live executor is never displaced...
    expect(() => host.attachRuntime({ descriptor: replacement, executeCommand: execute })).toThrow('without an executor');
    // ...but a dead one executes nothing and must not block recovery.
    host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
    host.attachRuntime({ descriptor: replacement, executeCommand: execute });
    expect(host.descriptor()).toMatchObject({ lifecycle: 'starting', runtimeGeneration: replacement.runtimeGeneration });
  });

  it('an open event stream grants the client lease and a terminal session grants none (P-009)', async () => {
    leaseGrants.length = 0;
    const host = new SuSessionHost({ descriptor: descriptor() });
    registerSuSessionHost(host);
    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'), host as SuSessionHost, { heartbeatMs: 0 });
    expect(leaseGrants).toEqual([host.descriptor().identity.advSessionId]);
    await response.body!.getReader().cancel();

    host.transition('ended', 'test');
    createSuSessionEventResponse(new Request('http://localhost/su-session/events'), host as SuSessionHost, { heartbeatMs: 0 });
    expect(leaseGrants).toHaveLength(1);
  });

  it('reconnects with Last-Event-ID without duplication after a consumer drops', async () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    registerSuSessionHost(host);
    host.transition('ready'); // sequence 2

    const first = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let firstText = '';
    for (let i = 0; i < 8 && !firstText.includes('id: 2'); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstText += decoder.decode(chunk.value, { stream: true });
    }
    expect(firstText).toContain('id: 1');
    expect(firstText).toContain('id: 2');
    await reader.cancel();
    await vi.waitFor(() => expect(host.subscriberCount).toBe(0));

    host.emit({
      type: 'transcript',
      phase: 'delta',
      turnId: 'turn-2',
      role: 'assistant',
      channel: 'text',
      content: 'missed while disconnected',
    }); // sequence 3
    host.emit({
      type: 'tool',
      phase: 'started',
      turnId: 'turn-2',
      callId: 'call-2',
      name: 'plans:get',
    }); // sequence 4

    const resumed = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events', {
        headers: { 'Last-Event-ID': '2' },
      }),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    queueMicrotask(() => {
      host.reconcileRuntimeExit({ expected: true, exitCode: 0 }); // sequence 5
    });
    const resumedText = await resumed.text();
    expect(resumedText).toContain('id: 3');
    expect(resumedText).toContain('id: 4');
    expect(resumedText).toContain('id: 5');
    expect(resumedText).not.toContain('id: 1\n');
    expect(resumedText).not.toContain('id: 2\n');
    expect(resumedText.match(/id: 3/g)).toHaveLength(1);
  });

  it('emits resync for an evicted replay gap, then continues from the live edge', async () => {
    const host = new SuSessionHost({ descriptor: descriptor(), replaySize: 2 });
    registerSuSessionHost(host);
    host.transition('ready'); // 2
    host.emit({
      type: 'transcript',
      phase: 'delta',
      turnId: 'turn-gap',
      role: 'assistant',
      channel: 'text',
      content: 'three',
    }); // 3
    host.emit({
      type: 'tool',
      phase: 'started',
      turnId: 'turn-gap',
      callId: 'call-gap',
      name: 'coord:orient',
    }); // 4, ring now [3,4]

    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events', {
        headers: { 'Last-Event-ID': '1' },
      }),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    queueMicrotask(() => {
      host.reconcileRuntimeExit({ expected: true, exitCode: 0 }); // 5
    });
    const text = await response.text();
    expect(text).toContain('event: resync');
    expect(text).toContain('"reason":"gap"');
    expect(text).not.toContain('id: 3\n');
    expect(text).not.toContain('id: 4\n');
    expect(text).toContain('id: 5');
  });

  it('unsubscribes a response whose body remains backpressured', async () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    registerSuSessionHost(host);
    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'),
      host as SuSessionHost,
      { heartbeatMs: 0, backpressureTimeoutMs: 5 },
    );

    await vi.waitFor(() => expect(host.subscriberCount).toBe(0), { timeout: 250 });
    await response.body?.cancel();
  });

  // pui-chat-first-ux-2026-09-28 P-002: a disposed host can never emit again.
  // Its open responses must END (without a terminal `done`, since the session
  // did not end) so a client re-subscribes to whichever host now serves the
  // chat, instead of idling on heartbeats until its startup budget runs out.
  it('ends an open response without a terminal done when its host is disposed', async () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    await vi.waitFor(() => expect(host.subscriberCount).toBe(1), { timeout: 1_000 });
    host.dispose('owning process lost');
    const text = await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('response stayed open')), 2_000)),
    ]);
    expect(text).not.toContain('event: done');
  });
});

describe('restart reconciliation on the host snapshot', () => {
  afterEach(() => _resetSuSessionHostsForTest());

  it('carries the reconciliation verdict a rehydrate classified', () => {
    const host = new SuSessionHost<'claude'>({
      descriptor: descriptor(),
      runtimeReconciliation: { action: 'rematerialize', reason: 'ended_archived', stalePid: true },
    });
    expect(host.snapshot().runtimeReconciliation).toEqual({
      action: 'rematerialize',
      reason: 'ended_archived',
      stalePid: true,
    });
  });

  it('reports null for a host created live at launch rather than inventing a clean reattach', () => {
    // A host that was never rehydrated performed no reconciliation. Reporting a
    // synthetic `reattach` here would make PUI unable to tell "attached to a
    // running runtime" from "rebuilt out of the archive" — which is the whole
    // distinction this field exists to carry.
    expect(new SuSessionHost<'claude'>({ descriptor: descriptor() }).snapshot().runtimeReconciliation).toBeNull();
  });
});

describe('agent-chat SU-session route registration', () => {
  it('EI-24367810949873789: returns the saved owner-turn receipt after the watchdog fires', async () => {
    const { suSessionRoutes } = await import('./endpoint-route/routes/agent-chats/su-session');
    const { registerRoute } = await import('./endpoint-route/define-route');
    const { DEFAULT_ROUTE_STACK } = await import('./endpoint-route/route-stack');
    const { runWithWorkspace } = await import('./workspace-als');
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = new SuSessionHost({ descriptor: { ...descriptor(), lifecycle: 'ready' }, executeCommand: execute });
    registerSuSessionHost(host);
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    const saved: unknown[] = [];
    const store: SuSessionCommandStore = {
      reserve: vi.fn(async (input, fingerprint) => {
        await committed;
        saved.push(input);
        return { created: true, receipt: { command: input, fingerprint, acceptedAt: input.issuedAt } };
      }),
      finish: vi.fn(async () => {}),
    };
    const accept = host.acceptCommand.bind(host);
    const spy = vi.spyOn(host, 'acceptCommand').mockImplementation((input) => accept(input, store));
    let reportDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => { reportDeadline = resolve; });
    const route = suSessionRoutes.find((candidate) => candidate.method === 'POST')!;
    const app = new Hono();
    registerRoute(app, {
      ...route, timeoutSec: 0.01,
      handler: (request, context) => {
        context.signal.addEventListener('abort', reportDeadline, { once: true });
        return route.handler(request, { ...context, input: undefined });
      },
    }, DEFAULT_ROUTE_STACK.filter((step) => step.name === 'invoke'));
    const turn = command('owner_turn');
    const send = () => runWithWorkspace('papercusp-workspace', () => app.request(
      '/harness/papercusp/agent-chats/chat-1/su-session/commands',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(turn) },
    ));
    const pending = Promise.resolve(send());
    try {
      await Promise.race([deadline, pending.then((response) => {
        throw new Error(`command settled before the held reservation: ${response.status}`);
      })]);
      expect(saved).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      commit();
      const response = await pending;
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ok: true, accepted: { status: 'accepted' } });
      await (await accept(turn, store)).terminal;
      const replay = await send();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      expect(saved).toEqual([turn]);
      expect(store.reserve).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      commit();
      await pending;
      spy.mockRestore();
      host.dispose();
      _resetSuSessionHostsForTest();
    }
  });

  it('mounts snapshot, resumable event, command and detach endpoints on agent-chats', async () => {
    const routes = (await import('./endpoint-route/routes/agent-chats/su-session')).default;
    expect(routes.map((route) => [route.method, route.path])).toEqual([
      ['GET', '/harness/:slug/agent-chats/:chatId/su-session'],
      ['GET', '/harness/:slug/agent-chats/:chatId/su-session/events'],
      ['POST', '/harness/:slug/agent-chats/:chatId/su-session/commands'],
      // P-009: keep an engine running after its client leaves.
      ['POST', '/harness/:slug/agent-chats/:chatId/su-session/detach'],
    ]);
  });
});
