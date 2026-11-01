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
  claudeSessionIdFromTranscriptPath,
  createClaudeSuSessionAdapter,
  openClaudeSuSession,
  type ClaudeSuRuntimeBinding,
  type ClaudeSuSessionControls,
} from './su-session-claude-adapter';

const CLAUDE_SESSION_A = '11111111-2222-4333-8444-555555555555';
const CLAUDE_SESSION_B = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

it.each((['pty', 'programmatic'] as const).flatMap(executionKind =>
  (['transcript', 'account', 'exit', 'dispose'] as const).map(action => ({ executionKind, action })),
))(
  'P-009: replaced Claude $executionKind adapter cannot publish stale $action callbacks', async ({ executionKind, action }) => {
    let settleAccount!: (account: string) => void;
    const account = new Promise<string>((resolve) => { settleAccount = resolve; });
    const old = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: `stale-claude-${executionKind}-${action}`, runtimeGeneration: 1, executionKind,
      servedAccountReader: () => account,
    });
    const refresh = action === 'account' ? old.refreshAccountServed() : Promise.resolve();
    old.reconcileRuntimeExit({ expected: false, exitCode: 1 });
    const ownerTurn = vi.fn<ClaudeSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const current = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: `stale-claude-${executionKind}-${action}`, host: old.host, runtimeGeneration: 2, executionKind,
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
  const routes = SU_EXEC_FORK_ROUTES.filter(row => row.provider === 'claude');
  expect(routes.map(row => row.execution).sort()).toEqual(['programmatic', 'pty']);
  for (const route of routes) {
    expect(route).toMatchObject({ support: 'supported', qualification: 'unknown' });
    expect(route.route).toBe(route.execution === 'pty' ? '--fork-session' : 'fork_from');
    expect(route.files.length).toBeGreaterThan(0);
    for (const file of route.files) expect(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
    if (route.execution === 'programmatic') expect(route.cases).toHaveLength(2);
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: `r7-${route.execution}`, register: false, executionKind: route.execution,
    });
    try {
      expect(adapter.host.descriptor().capabilities.commands.fork).toMatchObject({ state: 'conditional', implementation: 'native' });
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'fork', commandId: `fork-${route.execution}` }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'fork_requires_launcher', retryable: true } });
      expect(adapter.host.descriptor().identity.ownerId).toBe('su-claude-pui');
    } finally { adapter.dispose(); }
  }
  expect(routes.find(row => row.execution === 'programmatic')?.cases).toEqual([
    'claude native fork leaves pending question, queued input and accepted wake exclusively with parent',
    'claude native fork refuses changed lineage and removes unregistered history',
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
    backend: 'claude',
    advSessionId: 81,
    ownerId: 'su-claude-pui',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    planSlug: 'pui-plan',
    nativeSession,
  };
}

function runtime(
  sessionId = CLAUDE_SESSION_A,
  configDir: string | null = '/tmp/claude-config',
  transcriptPath: string | null = null,
): ClaudeSuRuntimeBinding {
  return {
    nativeSession: {
      backend: 'claude',
      source: 'adv_sessions',
      ownerId: 'su-claude-pui',
      sessionId,
      configDir,
      configDirSource: configDir ? 'live-process' : null,
      configDirUnresolvedReason: configDir ? null : 'not available in fixture',
      exactResumeSupported: true,
      missingReason: null,
    },
    transcriptPath,
  };
}

function command(
  adapter: ReturnType<typeof createClaudeSuSessionAdapter>,
  value: SuSessionCommand<'claude'> extends infer C
    ? C extends SuSessionCommand<'claude'>
      ? Omit<C, 'schema' | 'protocolVersion' | 'issuedAt' | 'target'>
      : never
    : never,
): SuSessionCommand<'claude'> {
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-28T00:00:00.000Z',
    target: adapter.host.descriptor().identity,
    ...value,
  } as SuSessionCommand<'claude'>;
}

function events(adapter: ReturnType<typeof createClaudeSuSessionAdapter>): SuSessionEvent<'claude'>[] {
  return adapter.host.recent.map(({ event }) => event);
}

describe('Claude SU-session backend — PUI entry and native transcript translation', () => {
  it('records the actual root model from native initialization and resumed transcript records', () => {
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), { agentChatId: 'model-proof', register: false });
    try {
      expect(adapter.host.descriptor().model).toBeNull();
      adapter.ingestNativeLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }));
      expect(adapter.host.descriptor().model).toBe('claude-sonnet-4-6');
      adapter.ingestNativeLine(JSON.stringify({ type: 'assistant', message: {
        role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'restored reply' }],
      } }));
      expect(adapter.host.descriptor().model).toBe('claude-opus-4-8');
      for (const line of [
        { type: 'user', message: { model: 'untrusted-user-value', content: 'hi' } },
        { type: 'assistant', parent_tool_use_id: 'child', message: { model: 'child-model', content: [] } },
        { type: 'assistant', isSidechain: true, message: { model: 'sidechain-model', content: [] } },
        { type: 'assistant', message: { model: '<synthetic>', content: [] } },
      ]) adapter.ingestNativeLine(JSON.stringify(line));
      expect(adapter.host.descriptor().model).toBe('claude-opus-4-8');
    } finally { adapter.dispose(); }
  });

  it('creates through the canonical PUI entry, translates prompts/tools/results, and opens typed cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-su-session-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${CLAUDE_SESSION_A}.jsonl`);
    const nativeLines = [
      {
        type: 'user', uuid: 'user-1', timestamp: '2026-08-28T00:00:01.000Z',
        message: { role: 'user', content: 'inspect the tree' },
      },
      {
        type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-28T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
      {
        type: 'user', uuid: 'tool-result-1', timestamp: '2026-08-28T00:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', content: '/workspace' }],
        },
      },
      {
        type: 'assistant', uuid: 'assistant-2', timestamp: '2026-08-28T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
      {
        type: 'result', subtype: 'success', is_error: false, result: 'Done',
        timestamp: '2026-08-28T00:00:05.000Z',
      },
      {
        type: 'assistant', uuid: 'user-card', timestamp: '2026-08-28T00:00:06.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', id: 'toolu-ask', name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Ship this change?',
                multiSelect: false,
                options: [{ label: 'Ship', description: 'Deploy now' }, { label: 'Hold' }],
              }],
            },
          }],
        },
      },
      {
        type: 'user', uuid: 'card-result', timestamp: '2026-08-28T00:00:07.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu-ask', content: 'Ship' }],
        },
      },
    ];
    writeFileSync(transcriptPath, nativeLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'ok', deferred: true, advSessionId: 81, ownerId: 'su-claude-pui',
        agent: body.agent, workspaceId: 'papercusp-workspace', harnessSlug: body.harness_slug,
        planSlug: body.plan_slug, nativeSession: null,
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const ownerTurn = vi.fn<ClaudeSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const opened = await openClaudeSuSession(
      {
        operation: 'create', backend: 'claude', carry: 'warm', slug: 'papercusp',
        planSlug: 'pui-plan', model: 'claude-opus-4-8', account: 'default',
      },
      {
        agentChatId: 'agent-chat-claude-create',
        controls: { ownerTurn },
        resolveRuntime: async () => runtime(CLAUDE_SESSION_A, dir, transcriptPath),
      },
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const adapter = opened.adapter;
    try {
      const launchBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
      expect(launchBody).toMatchObject({ agent: 'claude', defer_spawn: false, attached_engine: true, carry: 'warm', harness_slug: 'papercusp' });

      const ownerDispatch = adapter.host.startCommand(command(adapter, {
        type: 'owner_turn', commandId: 'owner-command-1', turnId: 'pui-turn-1', content: 'inspect the tree',
      }));
      await expect(ownerDispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', turnId: 'pui-turn-1', content: 'inspect the tree' });

      await adapter.consumeTranscriptSnapshot();
      const all = events(adapter);
      expect(adapter.host.descriptor()).toMatchObject({
        lifecycle: 'waiting-for-owner', model: 'claude-opus-4-8',
        identity: { nativeSessionId: CLAUDE_SESSION_A },
        backendExtension: { backend: 'claude', configDir: dir, configDirSource: 'live-process' },
      });
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'owner' && event.content === 'inspect the tree')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.content === 'I will inspect it.')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.content === 'Done.')).toBe(true);
      expect(all.find((event) => event.type === 'tool' && event.phase === 'started' && event.callId === 'toolu-bash')).toMatchObject({ name: 'Bash', input: { command: 'pwd' } });
      expect(all.find((event) => event.type === 'tool' && event.phase === 'completed' && event.callId === 'toolu-bash')).toMatchObject({ name: 'Bash', output: '/workspace', isError: false });
      expect(all.find((event) => event.type === 'card' && event.phase === 'opened' && event.card.correlationId === 'toolu-ask')).toMatchObject({ card: { prompt: 'Ship this change?', presentation: { kind: 'radio' } } });
      expect(all.find((event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === 'toolu-ask')).toMatchObject({ resolution: 'submitted' });
    } finally {
      adapter.dispose();
    }
  });

  it('replays a transcript idempotently: an early and a late snapshot, and a live record, each show once (WI-10004162)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-su-replay-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${CLAUDE_SESSION_A}.jsonl`);
    const line = (value: Record<string, unknown>) => JSON.stringify(value);
    const first = [
      line({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi! What can I help you with?' }] } }),
      'not json at all',
    ];
    writeFileSync(transcriptPath, first.join('\n') + '\n');
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay', register: false,
    });
    const count = (role: string, content: string) => events(adapter).filter((event) =>
      event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content).length;
    const malformed = () => events(adapter).filter((event) => event.type === 'error' && event.code === 'claude_record_malformed').length;
    try {
      // The early replay (before the SDK launch) and the authoritative one
      // after the SU tool connection read the same file on one host.
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hi! What can I help you with?')).toBe(1);
      expect(malformed()).toBe(1);

      // A record the engine streamed live is not repeated by a later replay,
      // while a record the runtime wrote since the last replay is added.
      adapter.ingestNativeLine(line({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: 'live reply' }] } }));
      writeFileSync(transcriptPath, [...first,
        line({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: 'live reply' }] } }),
        line({ type: 'assistant', uuid: 'a-3', message: { role: 'assistant', content: [{ type: 'text', text: 'written since' }] } }),
      ].join('\n') + '\n');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hi! What can I help you with?')).toBe(1);
      expect(count('assistant', 'live reply')).toBe(1);
      expect(count('assistant', 'written since')).toBe(1);
      expect(malformed()).toBe(1);
    } finally {
      adapter.dispose();
    }

    // Control: without the host's record ledger the same double replay shows
    // the greeting twice, the duplicate seen in the P-006 review — so the
    // counts above measure the dedup, not a quirk of the fixture.
    const control = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay-control', register: false,
    });
    try {
      control.host.claimNativeRecord = () => true;
      await control.consumeTranscriptSnapshot({ preserveLifecycle: true });
      await control.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(events(control).filter((event) => event.type === 'transcript' && event.phase === 'delta'
        && event.role === 'assistant' && event.content === 'Hi! What can I help you with?')).toHaveLength(2);
    } finally {
      control.dispose();
    }
  });

  it('replays each restored prompt as its own turn, under its saved owner-turn receipt id (WI-10004252)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-su-replay-turns-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${CLAUDE_SESSION_A}.jsonl`);
    const line = (value: Record<string, unknown>) => JSON.stringify(value);
    const user = (uuid: string, content: string) => line({ type: 'user', uuid, message: { role: 'user', content } });
    const reply = (uuid: string, text: string) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    // Claude's saved transcript: three owner turns and no `result` records.
    const records = [
      user('u-1', 'hi'), reply('a-1', 'Hello'),
      user('u-2', 'look around'), reply('a-2', 'Nothing here'),
      user('u-3', 'hi'), reply('a-3', 'Hello again'),
    ];
    writeFileSync(transcriptPath, records.join('\n') + '\n');
    const turnsOf = (adapter: ReturnType<typeof createClaudeSuSessionAdapter>, role: string, content: string) => events(adapter)
      .flatMap((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content
        ? [event.turnId] : []);

    // 'turn-live' was already shown live on this host, so no replayed prompt
    // may take it; 'hi' then takes turn-a and turn-b in order, and the prompt
    // typed natively (no receipt) gets a fresh id of its own.
    const receipts = vi.fn(async () => [
      { turnId: 'turn-live', content: 'hi' },
      { turnId: 'turn-a', content: ' hi\n' },
      { turnId: 'turn-b', content: 'hi' },
    ]);
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay-turns', register: false, ownerTurnReceipts: receipts,
    });
    try {
      adapter.correlateOwnerTurn('turn-live');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: CLAUDE_SESSION_A }));
      expect(turnsOf(adapter, 'owner', 'hi')).toEqual(['turn-a', 'turn-b']);
      expect(turnsOf(adapter, 'assistant', 'Hello')).toEqual(['turn-a']);
      expect(turnsOf(adapter, 'assistant', 'Hello again')).toEqual(['turn-b']);
      const [native] = turnsOf(adapter, 'owner', 'look around');
      expect(native).toMatch(/^claude:u-2:/);
      expect(turnsOf(adapter, 'assistant', 'Nothing here')).toEqual([native]);
    } finally {
      adapter.dispose();
    }

    // Without receipts (or when reading them fails) every restored prompt
    // still opens its own turn.
    const unmatched = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay-turns-unmatched', register: false,
      ownerTurnReceipts: async () => { throw new Error('receipt read failed'); },
    });
    try {
      await unmatched.consumeTranscriptSnapshot({ preserveLifecycle: true });
      const owners = [...turnsOf(unmatched, 'owner', 'hi'), ...turnsOf(unmatched, 'owner', 'look around')];
      expect(owners).toHaveLength(3);
      expect(new Set(owners).size).toBe(3);
    } finally {
      unmatched.dispose();
    }

    // Calibration: the same records ingested WITHOUT replay (the pre-fix
    // replay path) share one turn id, because nothing ends a turn without a
    // `result` record. So the distinct ids above measure the replay fix.
    const calibration = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay-turns-calibration', register: false,
    });
    try {
      for (const record of records) calibration.ingestNativeLine(record);
      const owners = [...turnsOf(calibration, 'owner', 'hi'), ...turnsOf(calibration, 'owner', 'look around')];
      expect(owners).toHaveLength(3);
      expect(new Set(owners).size).toBe(1);
    } finally {
      calibration.dispose();
    }
  });

  it('maps interrupt/resume, preserves identity across replacement, and converges unexpected exit', async () => {
    const interrupt = vi.fn<ClaudeSuSessionControls['interrupt']>(async () => ({ ok: true }));
    const resume = vi.fn<ClaudeSuSessionControls['resume']>(async () => ({ ok: true }));
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-reconcile', controls: { interrupt, resume }, register: false,
    });
    try {
      const identity = adapter.host.descriptor().identity;
      const interrupted = adapter.host.startCommand(command(adapter, {
        type: 'interrupt', commandId: 'interrupt-command-1', reason: 'owner stop',
      }));
      await expect(interrupted.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(interrupt).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', reason: 'owner stop' });
      const resumed = adapter.host.startCommand(command(adapter, {
        type: 'resume', commandId: 'resume-command-1', cause: 'runtime-replacement',
      }));
      await expect(resumed.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(resume).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', sessionId: CLAUDE_SESSION_A, cause: 'runtime-replacement' });

      adapter.replaceRuntime(runtime(CLAUDE_SESSION_B, '/tmp/claude-config-successor'), 'carry successor attached');
      expect(adapter.host.descriptor()).toMatchObject({
        identity, runtimeGeneration: 1, lifecycle: 'ready',
        backendExtension: { backend: 'claude', configDir: '/tmp/claude-config-successor' },
      });
      expect(adapter.runtime.nativeSession.sessionId).toBe(CLAUDE_SESSION_B);

      adapter.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
      adapter.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
      expect(adapter.host.descriptor().lifecycle).toBe('failed');
      expect(events(adapter).filter((event) => event.type === 'lifecycle' && event.state === 'failed')).toHaveLength(1);
    } finally {
      adapter.dispose();
    }
  });

  it('maps an accepted native end to one terminal state and exposes stable transcript ids', async () => {
    const end = vi.fn<ClaudeSuSessionControls['end']>(async () => ({ ok: true }));
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-end', controls: { end }, register: false,
    });
    try {
      const dispatch = adapter.host.startCommand(command(adapter, {
        type: 'end', commandId: 'end-command-1', reason: 'PUI pane closed',
      }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(end).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', reason: 'PUI pane closed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ended');
      expect(events(adapter).filter((event) => event.type === 'lifecycle' && event.state === 'ended')).toHaveLength(1);
      expect(claudeSessionIdFromTranscriptPath(`/tmp/projects/${CLAUDE_SESSION_A}.jsonl`)).toBe(CLAUDE_SESSION_A);
      expect(claudeSessionIdFromTranscriptPath('/tmp/projects/not-a-session.txt')).toBeNull();
    } finally {
      adapter.dispose();
    }
  });

  it('surfaces a recoverable native result failure once', () => {
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-error', register: false,
    });
    try {
      adapter.ingestNativeLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }));
      adapter.ingestNativeLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }));
      expect(events(adapter).filter((event) => event.type === 'error')).toEqual([
        expect.objectContaining({ scope: 'turn', code: 'error', message: 'rate limited', recoverable: true }),
      ]);
      expect(adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
    } finally {
      adapter.dispose();
    }
  });
});
