import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCommand,
  type SuSessionEvent,
} from '@papercusp/chat-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SU_EXEC_FORK_ROUTES } from './__fixtures__/su-execution-parity';

import type { PuiSuSessionBinding } from './launch-agent';
import {
  codexRolloutIdFromPath,
  createCodexSuSessionAdapter,
  openCodexSuSession,
  resolveCodexSuRuntime,
  type CodexSuRuntimeBinding,
  type CodexSuSessionControls,
} from './su-session-codex-adapter';

const ROLLOUT_A = '019f0000-1111-7222-8333-444444444444';
const ROLLOUT_B = '019f0000-5555-7666-8777-888888888888';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

it.each((['pty', 'programmatic'] as const).flatMap(executionKind =>
  (['transcript', 'account', 'exit', 'dispose'] as const).map(action => ({ executionKind, action })),
))(
  'P-009: replaced Codex $executionKind adapter cannot publish stale $action callbacks', async ({ executionKind, action }) => {
    let settleAccount!: (account: string) => void;
    const account = new Promise<string>((resolve) => { settleAccount = resolve; });
    const old = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: `stale-codex-${executionKind}-${action}`, runtimeGeneration: 1, executionKind,
      servedAccountReader: () => account,
    });
    const refresh = action === 'account' ? old.refreshAccountServed() : Promise.resolve();
    old.reconcileRuntimeExit({ expected: false, exitCode: 1 });
    const ownerTurn = vi.fn<CodexSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const current = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: `stale-codex-${executionKind}-${action}`, host: old.host, runtimeGeneration: 2, executionKind,
      runtimeReady: () => true, controls: { ownerTurn },
    });
    try {
      const before = current.host.snapshot();
      if (action === 'transcript') old.ingestNativeLine('malformed old frame');
      if (action === 'exit') old.reconcileRuntimeExit({ expected: false, exitCode: 137 });
      if (action === 'dispose') old.dispose();
      settleAccount('old-account');
      await refresh;
      expect(current.host.snapshot()).toEqual(before);
      const dispatch = current.host.startCommand(command(current, {
        type: 'owner_turn', commandId: 'current-turn', turnId: 'current-turn', content: 'continue',
      }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledOnce();
    } finally { settleAccount('old-account'); current.dispose(); old.dispose(); }
  },
);

it('SU-EXEC R-7 acceptance contract', async () => {
  const routes = SU_EXEC_FORK_ROUTES.filter(row => row.provider === 'codex');
  expect(routes.map(row => row.execution).sort()).toEqual(['programmatic', 'pty']);
  for (const route of routes) {
    expect(route).toMatchObject({ support: 'supported', route: 'native_fork_source', qualification: 'unknown' });
    expect(route.files.length).toBeGreaterThan(0);
    expect(route.cases.length).toBeGreaterThan(0);
    for (const file of route.files) expect(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
    const adapter = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: `r7-${route.execution}`, register: false, executionKind: route.execution,
    });
    try {
      expect(adapter.host.descriptor().capabilities.commands.fork).toMatchObject({ state: 'conditional', implementation: 'native' });
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'fork', commandId: `fork-${route.execution}` }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'fork_requires_launcher', retryable: true } });
      expect(adapter.host.descriptor().identity.ownerId).toBe('su-codex-pui');
    } finally { adapter.dispose(); }
  }
  expect(routes.flatMap(row => [...row.cases])).toEqual([
    'registers native child ancestry before success; scenario=registered',
    'registers native child ancestry before success; scenario=stale-source',
    'registers native child ancestry before success; scenario=startup-failure',
    'registers native child ancestry before success; scenario=bootstrap-failure',
    'codex native fork leaves pending question, queued input and accepted wake exclusively with parent',
    'transfers complete paginated history across homes and preserves parent isolation',
    'transfers incomplete paginated history across homes and preserves parent isolation',
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function binding(nativeSession: PuiSuSessionBinding['nativeSession'] = null): PuiSuSessionBinding {
  return {
    operation: 'created',
    backend: 'codex',
    advSessionId: 71,
    ownerId: 'su-codex-pui',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    planSlug: 'pui-plan',
    nativeSession,
  };
}

function runtime(
  rolloutId = ROLLOUT_A,
  codexHome = '/tmp/codex-home',
  rolloutPath: string | null = null,
): CodexSuRuntimeBinding {
  return {
    nativeSession: {
      backend: 'codex',
      source: 'adv_sessions',
      ownerId: 'su-codex-pui',
      codexHome,
      rolloutId,
      exactResumeSupported: true,
      missingReason: null,
    },
    rolloutPath,
  };
}

function command(
  adapter: ReturnType<typeof createCodexSuSessionAdapter>,
  value: SuSessionCommand<'codex'> extends infer C
    ? C extends SuSessionCommand<'codex'>
      ? Omit<C, 'schema' | 'protocolVersion' | 'issuedAt' | 'target'>
      : never
    : never,
): SuSessionCommand<'codex'> {
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-28T00:00:00.000Z',
    target: adapter.host.descriptor().identity,
    ...value,
  } as SuSessionCommand<'codex'>;
}

function events(adapter: ReturnType<typeof createCodexSuSessionAdapter>): SuSessionEvent<'codex'>[] {
  return adapter.host.recent.map(({ event }) => event);
}

describe('Codex SU-session backend — real PUI entry and native rollout translation', () => {
  it('attaches by the live thread id before the first rollout exists, then upgrades exact-resume state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pre-turn-'));
    tempDirs.push(dir);
    const liveThread = '01a04fe7-9310-7f81-8bcf-0887a91a811b';
    const row = {
      id: 71,
      workspaceId: 'papercusp-workspace',
      planSlug: null,
      agent: 'codex',
      role: null,
      feature: null,
      mode: 'console',
      terminalBin: null,
      pid: 4242,
      windowId: null,
      ompThreadId: null,
      label: null,
      cwd: '/repo',
      coordOwnerId: 'su-codex-pui',
      sessionId: null,
      display: null,
      launchArgv: null,
      launchedAt: null,
      startedAt: '2026-08-29T23:42:48.000Z',
      endedAt: null,
      exitCode: null,
      endedBy: null,
      endedSignal: null,
    } as const;
    const noRollout = await resolveCodexSuRuntime(binding(), {
      getSession: async () => row,
      findRolloutPath: async () => null,
      findLiveThreadId: async () => liveThread,
      findHost: () => ({}) as never,
    });
    expect(noRollout).toMatchObject({
      nativeSession: {
        rolloutId: liveThread,
        exactResumeSupported: false,
        missingReason: expect.stringContaining('not persisted yet'),
      },
      rolloutPath: null,
    });

    const rolloutPath = join(dir, `rollout-2026-08-29T23-42-48-${liveThread}.jsonl`);
    const persisted = await resolveCodexSuRuntime(binding(), {
      getSession: async () => row,
      findRolloutPath: async () => rolloutPath,
      findLiveThreadId: async () => {
        throw new Error('rollout identity must win once the file exists');
      },
      findHost: () => null,
    });
    expect(codexRolloutIdFromPath(rolloutPath)).toBe(liveThread);
    expect(persisted).toMatchObject({
      nativeSession: {
        rolloutId: liveThread,
        exactResumeSupported: true,
        missingReason: null,
      },
      rolloutPath,
    });
  });

  it('replays a rollout idempotently: an early and a late snapshot each show a record once (WI-10004162)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-su-replay-'));
    tempDirs.push(dir);
    const rolloutPath = join(dir, `rollout-2026-08-28T00-00-00-${ROLLOUT_A}.jsonl`);
    const first = [
      { type: 'session_meta', timestamp: '2026-08-28T00:00:00.000Z', payload: { id: ROLLOUT_A } },
      { type: 'response_item', timestamp: '2026-08-28T00:00:01.000Z', payload: { type: 'message', id: 'owner-1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
      { type: 'response_item', timestamp: '2026-08-28T00:00:02.000Z', payload: { type: 'message', id: 'assistant-1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there.' }] } },
    ];
    writeFileSync(rolloutPath, first.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const adapter = createCodexSuSessionAdapter(binding(), runtime(ROLLOUT_A, dir, rolloutPath), {
      agentChatId: 'agent-chat-codex-replay', register: false,
    });
    const count = (role: string, content: string) => events(adapter).filter((event) =>
      event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content).length;
    try {
      await adapter.consumeRolloutSnapshot({ preserveLifecycle: true });
      await adapter.consumeRolloutSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hello there.')).toBe(1);
      writeFileSync(rolloutPath, [...first,
        { type: 'response_item', timestamp: '2026-08-28T00:00:03.000Z', payload: { type: 'message', id: 'assistant-2', role: 'assistant', content: [{ type: 'output_text', text: 'written since' }] } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      await adapter.consumeRolloutSnapshot({ preserveLifecycle: true });
      expect(count('assistant', 'Hello there.')).toBe(1);
      expect(count('assistant', 'written since')).toBe(1);
    } finally {
      adapter.dispose();
    }
  });

  it('replays each restored prompt under its saved receipt turn id (WI-10004254)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-su-receipts-'));
    tempDirs.push(dir);
    const rolloutPath = join(dir, `rollout-2026-08-28T00-00-00-${ROLLOUT_A}.jsonl`);
    const user = (id: string, text: string) => ({ type: 'response_item', payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] } });
    const reply = (id: string, text: string) => ({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } });
    writeFileSync(rolloutPath, [
      { type: 'session_meta', timestamp: '2026-08-28T00:00:00.000Z', payload: { id: ROLLOUT_A } },
      user('owner-1', 'hi'), reply('assistant-1', 'Hello'),
      user('owner-2', 'look around'), reply('assistant-2', 'Nothing here'),
      user('owner-3', 'hi'), reply('assistant-3', 'Hello again'),
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const turnsOf = (adapter: ReturnType<typeof createCodexSuSessionAdapter>, role: string, content: string) => events(adapter)
      .flatMap((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content
        ? [event.turnId] : []);

    // 'turn-live' was delivered live through this adapter, so no replayed
    // prompt may take it; 'hi' then takes turn-a and turn-b in order, and the
    // prompt typed natively (no receipt) keeps a codex: id of its own.
    const receipts = vi.fn(async () => [
      { turnId: 'turn-live', content: 'hi' },
      { turnId: 'turn-a', content: ' hi\n' },
      { turnId: 'turn-b', content: 'hi' },
    ]);
    const ownerTurn = vi.fn<CodexSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const adapter = createCodexSuSessionAdapter(binding(), runtime(ROLLOUT_A, dir, rolloutPath), {
      agentChatId: 'agent-chat-codex-replay-turns', register: false, controls: { ownerTurn }, ownerTurnReceipts: receipts,
    });
    try {
      const live = adapter.host.startCommand(command(adapter, { type: 'owner_turn', commandId: 'owner-live', turnId: 'turn-live', content: 'hi' }));
      await expect(live.terminal).resolves.toMatchObject({ status: 'completed' });
      await adapter.consumeRolloutSnapshot({ preserveLifecycle: true });
      expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: ROLLOUT_A }));
      expect(turnsOf(adapter, 'owner', 'hi')).toEqual(['turn-a', 'turn-b']);
      expect(turnsOf(adapter, 'assistant', 'Hello')).toEqual(['turn-a']);
      expect(turnsOf(adapter, 'assistant', 'Hello again')).toEqual(['turn-b']);
      const [native] = turnsOf(adapter, 'owner', 'look around');
      expect(native).toMatch(/^codex:owner-2:/);
      expect(turnsOf(adapter, 'assistant', 'Nothing here')).toEqual([native]);
    } finally {
      adapter.dispose();
    }

    // Without receipts (or when reading them fails) every restored prompt
    // still opens its own codex: turn.
    const unmatched = createCodexSuSessionAdapter(binding(), runtime(ROLLOUT_A, dir, rolloutPath), {
      agentChatId: 'agent-chat-codex-replay-turns-unmatched', register: false,
      ownerTurnReceipts: async () => { throw new Error('receipt read failed'); },
    });
    try {
      await unmatched.consumeRolloutSnapshot({ preserveLifecycle: true });
      const owners = [...turnsOf(unmatched, 'owner', 'hi'), ...turnsOf(unmatched, 'owner', 'look around')];
      expect(owners).toHaveLength(3);
      expect(new Set(owners).size).toBe(3);
      expect(owners.every((turnId) => turnId.startsWith('codex:'))).toBe(true);
    } finally {
      unmatched.dispose();
    }
  });

  it('creates through openPuiSuSession, delivers an owner turn, translates tools/text, and routes fork to the tracked launcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-su-session-'));
    tempDirs.push(dir);
    const rolloutPath = join(dir, `rollout-2026-08-28T00-00-00-${ROLLOUT_A}.jsonl`);
    const nativeLines = [
      { type: 'session_meta', timestamp: '2026-08-28T00:00:00.000Z', payload: { id: ROLLOUT_A } },
      { type: 'turn_context', timestamp: '2026-08-28T00:00:01.000Z', payload: { model: 'gpt-5.6-codex' } },
      {
        type: 'event_msg',
        timestamp: '2026-08-28T00:00:02.000Z',
        payload: { type: 'task_started', turn_id: 'native-turn-1' },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-28T00:00:03.000Z',
        payload: {
          type: 'message',
          id: 'owner-message-1',
          role: 'user',
          content: [{ type: 'input_text', text: 'inspect the tree' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-28T00:00:04.000Z',
        payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"pwd"}' },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-28T00:00:05.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: [{ type: 'input_text', text: '/workspace' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-28T00:00:06.000Z',
        payload: { type: 'reasoning', summary: [{ text: 'The working tree is ready.' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-28T00:00:07.000Z',
        payload: {
          type: 'message',
          id: 'assistant-message-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-08-28T00:00:08.000Z',
        payload: { type: 'task_complete', status: 'completed', turn_id: 'native-turn-1' },
      },
    ];
    writeFileSync(rolloutPath, nativeLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: 'ok',
          deferred: true,
          advSessionId: 71,
          ownerId: 'su-codex-pui',
          agent: body.agent,
          workspaceId: 'papercusp-workspace',
          harnessSlug: body.harness_slug,
          planSlug: body.plan_slug,
          nativeSession: null,
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const ownerTurn = vi.fn<CodexSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const opened = await openCodexSuSession(
      {
        operation: 'create',
        backend: 'codex',
        carry: 'warm',
        slug: 'papercusp',
        planSlug: 'pui-plan',
        model: 'gpt-5.6-codex',
        account: 'default',
      },
      {
        agentChatId: 'agent-chat-codex-create',
        controls: { ownerTurn },
        resolveRuntime: async () => runtime(ROLLOUT_A, dir, rolloutPath),
      },
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const adapter = opened.adapter;
    try {
      const launchBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(launchBody).toMatchObject({
        agent: 'codex',
        defer_spawn: false,
        attached_engine: true,
        carry: 'warm',
        harness_slug: 'papercusp',
        plan_slug: 'pui-plan',
      });

      const ownerDispatch = adapter.host.startCommand(
        command(adapter, {
          type: 'owner_turn',
          commandId: 'owner-command-1',
          turnId: 'pui-turn-1',
          content: 'inspect the tree',
        }),
      );
      expect(ownerDispatch.accepted?.status).toBe('accepted');
      await expect(ownerDispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledWith({
        ownerId: 'su-codex-pui',
        turnId: 'pui-turn-1',
        content: 'inspect the tree',
      });

      await adapter.consumeRolloutSnapshot();
      const all = events(adapter);
      expect(adapter.host.descriptor()).toMatchObject({
        lifecycle: 'waiting-for-owner',
        model: 'gpt-5.6-codex',
        backendExtension: { backend: 'codex', codexHome: dir },
      });
      expect(
        all
          .filter((event) => event.type === 'transcript' && event.phase === 'delta')
          .map((event) => ({
            role: event.type === 'transcript' ? event.role : null,
            channel: event.type === 'transcript' ? event.channel : null,
            content: event.type === 'transcript' && event.phase === 'delta' ? event.content : null,
          })),
      ).toEqual(
        expect.arrayContaining([
          { role: 'owner', channel: 'text', content: 'inspect the tree' },
          { role: 'assistant', channel: 'reasoning', content: 'The working tree is ready.' },
          { role: 'assistant', channel: 'text', content: 'Done.' },
        ]),
      );
      expect(all).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool',
            phase: 'started',
            callId: 'call-1',
            name: 'shell',
            input: { cmd: 'pwd' },
          }),
          expect.objectContaining({
            type: 'tool',
            phase: 'completed',
            callId: 'call-1',
            name: 'shell',
            output: '/workspace',
            isError: false,
          }),
        ]),
      );

      const fork = adapter.host.startCommand(
        command(adapter, {
          type: 'fork',
          commandId: 'fork-command-1',
        }),
      );
      expect(fork.accepted).not.toBeNull();
      await expect(fork.terminal).resolves.toMatchObject({
        status: 'refused',
        refusal: { code: 'fork_requires_launcher', retryable: true },
      });
      expect(adapter.host.descriptor().capabilities.commands.fork).toMatchObject({ state: 'conditional', implementation: 'native' });
      expect(adapter.host.descriptor().capabilities.features['interactive-cards']).toMatchObject({
        state: 'unsupported',
      });
    } finally {
      adapter.dispose();
    }
  });

  it('maps interrupt/resume, preserves identity across runtime replacement, and reconciles unexpected exit', async () => {
    const interrupt = vi.fn<CodexSuSessionControls['interrupt']>(async () => ({ ok: true }));
    const resume = vi.fn<CodexSuSessionControls['resume']>(async () => ({ ok: true }));
    const adapter = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-codex-reconcile',
      controls: { interrupt, resume },
    });
    try {
      const originalIdentity = adapter.host.descriptor().identity;
      const interrupted = adapter.host.startCommand(
        command(adapter, {
          type: 'interrupt',
          commandId: 'interrupt-command-1',
          reason: 'owner stop',
        }),
      );
      await expect(interrupted.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(adapter.host.descriptor().lifecycle).toBe('interrupted');
      expect(interrupt).toHaveBeenCalledWith({ ownerId: 'su-codex-pui', reason: 'owner stop' });

      const resumed = adapter.host.startCommand(
        command(adapter, {
          type: 'resume',
          commandId: 'resume-command-1',
          cause: 'runtime-replacement',
        }),
      );
      await expect(resumed.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ready');
      expect(resume).toHaveBeenCalledWith({
        ownerId: 'su-codex-pui',
        rolloutId: ROLLOUT_A,
        cause: 'runtime-replacement',
      });

      adapter.replaceRuntime(runtime(ROLLOUT_B, '/tmp/codex-home-successor'), 'carry successor attached');
      expect(adapter.host.descriptor()).toMatchObject({
        identity: originalIdentity,
        runtimeGeneration: 1,
        lifecycle: 'ready',
        backendExtension: { backend: 'codex', codexHome: '/tmp/codex-home-successor' },
      });
      expect(adapter.runtime.nativeSession.rolloutId).toBe(ROLLOUT_B);

      adapter.reconcileRuntimeExit({ expected: false, exitCode: 17, signal: null });
      expect(adapter.host.descriptor().lifecycle).toBe('failed');
      expect(events(adapter)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'lifecycle',
            state: 'failed',
            reason: 'exit=17',
            runtimeGeneration: 1,
          }),
        ]),
      );
    } finally {
      adapter.dispose();
    }
  });

  it('maps an accepted native end to one terminal ended state', async () => {
    const end = vi.fn<CodexSuSessionControls['end']>(async () => ({ ok: true }));
    const adapter = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-codex-end',
      controls: { end },
    });
    try {
      const dispatch = adapter.host.startCommand(
        command(adapter, {
          type: 'end',
          commandId: 'end-command-1',
          reason: 'PUI pane closed',
        }),
      );
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(end).toHaveBeenCalledWith({ ownerId: 'su-codex-pui', reason: 'PUI pane closed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ended');
      expect(events(adapter).filter((event) => event.type === 'lifecycle' && event.state === 'ended')).toHaveLength(1);
    } finally {
      adapter.dispose();
    }
  });

  it('surfaces one recoverable turn error when Codex writes both error and task_complete records', async () => {
    const adapter = createCodexSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-codex-error',
    });
    try {
      const first = JSON.stringify({
        type: 'event_msg',
        payload: { type: 'error', turn_id: 'turn-failed', code: 'rate_limit_exceeded', message: 'try later' },
      });
      const terminal = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-failed',
          status: 'failed',
          error: { code: 'rate_limit_exceeded', message: 'try later' },
        },
      });
      adapter.ingestNativeLine(first);
      adapter.ingestNativeLine(terminal);
      expect(events(adapter).filter((event) => event.type === 'error')).toEqual([
        expect.objectContaining({
          scope: 'turn',
          code: 'rate_limit_exceeded',
          message: 'try later',
          recoverable: true,
        }),
      ]);
      expect(adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
    } finally {
      adapter.dispose();
    }
  });
});
