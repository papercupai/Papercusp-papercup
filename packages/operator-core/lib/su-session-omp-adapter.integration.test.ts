import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCommand,
  type SuSessionEvent,
} from '@papercusp/chat-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PuiSuSessionBinding } from './launch-agent';
import {
  createOmpSuSessionAdapter,
  ompThreadIdFromTranscriptPath,
  openOmpSuSession,
  resolveOmpSuRuntime,
  type OmpSuRuntimeBinding,
  type OmpSuSessionControls,
} from './su-session-omp-adapter';

const THREAD_A = '11111111-2222-4333-8444-555555555555';
const THREAD_B = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function binding(nativeSession: PuiSuSessionBinding['nativeSession'] = null): PuiSuSessionBinding {
  return {
    operation: 'created', backend: 'omp', advSessionId: 91, ownerId: 'su-omp-pui',
    workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', planSlug: 'pui-plan', nativeSession,
  };
}

function runtime(threadId = THREAD_A, agentHome: string | null = '/tmp/omp-agent', transcriptPath: string | null = null): OmpSuRuntimeBinding {
  return {
    nativeSession: {
      backend: 'omp', source: 'adv_sessions', ownerId: 'su-omp-pui', ompThreadId: threadId,
      agentHome, exactResumeSupported: true, missingReason: null,
    },
    transcriptPath,
  };
}

function command(adapter: ReturnType<typeof createOmpSuSessionAdapter>, value: SuSessionCommand<'omp'> extends infer C
  ? C extends SuSessionCommand<'omp'> ? Omit<C, 'schema' | 'protocolVersion' | 'issuedAt' | 'target'> : never : never): SuSessionCommand<'omp'> {
  return {
    schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-28T00:00:00.000Z', target: adapter.host.descriptor().identity, ...value,
  } as SuSessionCommand<'omp'>;
}

function events(adapter: ReturnType<typeof createOmpSuSessionAdapter>): SuSessionEvent<'omp'>[] {
  return adapter.host.recent.map(({ event }) => event);
}

describe('OMP SU-session backend — PUI entry and native session translation', () => {
  it('creates through the canonical PUI entry and translates OMP messages, tools, reasoning, and cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-su-session-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${Date.now()}_${THREAD_A}.jsonl`);
    const lines = [
      { type: 'session', id: THREAD_A, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/workspace' },
      { type: 'message', id: 'user-1', timestamp: '2026-08-28T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'inspect the tree' }] } },
      { type: 'message', id: 'assistant-1', timestamp: '2026-08-28T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should inspect first.' }, { type: 'text', text: 'I will inspect it.' }, { type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { command: 'pwd' } }] } },
      { type: 'message', id: 'tool-1', timestamp: '2026-08-28T00:00:03.000Z', message: { role: 'toolResult', content: [{ type: 'text', text: '/workspace' }], toolCallId: 'call-bash' } },
      { type: 'message', id: 'assistant-2', timestamp: '2026-08-28T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } },
      { type: 'message', id: 'assistant-card', timestamp: '2026-08-28T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-ask', name: 'AskUserQuestion', arguments: { questions: [{ question: 'Ship this change?', options: [{ label: 'Ship' }, { label: 'Hold' }] }] } }] } },
      { type: 'message', id: 'tool-card', timestamp: '2026-08-28T00:00:06.000Z', message: { role: 'toolResult', content: [{ type: 'text', text: 'Ship' }], toolCallId: 'call-ask' } },
    ];
    writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: 'ok', deferred: true, advSessionId: 91, ownerId: 'su-omp-pui', agent: body.agent, workspaceId: 'papercusp-workspace', harnessSlug: body.harness_slug, planSlug: body.plan_slug, nativeSession: null }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const ownerTurn = vi.fn<OmpSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const opened = await openOmpSuSession(
      { operation: 'create', backend: 'omp', carry: 'warm', slug: 'papercusp', planSlug: 'pui-plan', model: 'gpt-5.6-omp', account: 'default' },
      { agentChatId: 'agent-chat-omp-create', controls: { ownerTurn }, resolveRuntime: async () => runtime(THREAD_A, dir, transcriptPath) },
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const adapter = opened.adapter;
    try {
      expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ agent: 'omp', defer_spawn: false, attached_engine: true, carry: 'warm' });
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'owner_turn', commandId: 'owner-1', turnId: 'pui-turn-1', content: 'inspect the tree' }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', turnId: 'pui-turn-1', content: 'inspect the tree' });
      await adapter.consumeTranscriptSnapshot();
      const all = events(adapter);
      expect(adapter.host.descriptor()).toMatchObject({ lifecycle: 'waiting-for-owner', model: 'gpt-5.6-omp', identity: { nativeSessionId: THREAD_A }, backendExtension: { backend: 'omp', agentHome: dir } });
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'owner' && event.content === 'inspect the tree')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.channel === 'reasoning' && event.content === 'I should inspect first.')).toBe(true);
      expect(all.find((event) => event.type === 'tool' && event.phase === 'started' && event.callId === 'call-bash')).toMatchObject({ name: 'bash', input: { command: 'pwd' } });
      expect(all.find((event) => event.type === 'tool' && event.phase === 'completed' && event.callId === 'call-bash')).toMatchObject({ output: '/workspace', isError: false });
      expect(all.find((event) => event.type === 'card' && event.phase === 'opened' && event.card.correlationId === 'call-ask')).toMatchObject({ card: { prompt: 'Ship this change?', presentation: { kind: 'radio' } } });
      expect(all.find((event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === 'call-ask')).toMatchObject({ resolution: 'submitted' });
    } finally { adapter.dispose(); }
  });

  it('keeps the turn running across a toolUse stop and ends it on the final stop (pui-chat-first-ux P-025)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-su-tooluse-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${Date.now()}_${THREAD_A}.jsonl`);
    // The shape OMP really writes: the message that carries the tool call
    // stops with `toolUse`, the tool result follows, then the reply stops.
    const midTurn = [
      { type: 'session', id: THREAD_A, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/workspace' },
      { type: 'message', id: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'edit calc.js' }] } },
      { type: 'message', id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Change add().' }, { type: 'toolCall', id: 'call-edit', name: 'edit', arguments: { i: 'add c', input: '[calc.js#5ED7]\nPUT 1.=3:\n+x\n' } }], stopReason: 'toolUse' } },
      { type: 'message', id: 'tool-1', message: { role: 'toolResult', content: [{ type: 'text', text: '[calc.js#FB74]\n1:x' }], toolCallId: 'call-edit' } },
    ];
    writeFileSync(transcriptPath, midTurn.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const adapter = createOmpSuSessionAdapter(binding(), runtime(THREAD_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-omp-tooluse', register: false,
    });
    const turnEnds = () => events(adapter).filter((event) =>
      event.type === 'lifecycle' && event.state === 'waiting-for-owner').length;
    try {
      await adapter.consumeTranscriptSnapshot();
      expect(adapter.host.descriptor().lifecycle).toBe('running');
      expect(turnEnds()).toBe(0);
      writeFileSync(transcriptPath, [...midTurn,
        { type: 'message', id: 'assistant-2', message: { role: 'assistant', content: [{ type: 'text', text: 'add now takes c.' }], stopReason: 'stop' } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      await adapter.consumeTranscriptSnapshot();
      expect(adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
      expect(turnEnds()).toBe(1);
    } finally { adapter.dispose(); }
  });

  it('replays a session file idempotently: an early and a late snapshot each show a record once (WI-10004162)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-su-replay-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${Date.now()}_${THREAD_A}.jsonl`);
    const first = [
      { type: 'session', id: THREAD_A, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/workspace' },
      { type: 'message', id: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }], stopReason: 'stop' } },
    ];
    writeFileSync(transcriptPath, first.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const adapter = createOmpSuSessionAdapter(binding(), runtime(THREAD_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-omp-replay', register: false,
    });
    const count = (role: string, content: string) => events(adapter).filter((event) =>
      event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content).length;
    try {
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hello there.')).toBe(1);
      writeFileSync(transcriptPath, [...first,
        { type: 'message', id: 'assistant-2', message: { role: 'assistant', content: [{ type: 'text', text: 'written since' }], stopReason: 'stop' } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('assistant', 'Hello there.')).toBe(1);
      expect(count('assistant', 'written since')).toBe(1);
    } finally { adapter.dispose(); }
  });

  it('replays each restored prompt under its saved receipt turn id (WI-10004254)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-su-receipts-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${Date.now()}_${THREAD_A}.jsonl`);
    const user = (id: string, text: string) => ({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } });
    const reply = (id: string, text: string) => ({ type: 'message', id, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    writeFileSync(transcriptPath, [
      { type: 'session', id: THREAD_A, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/workspace' },
      user('user-1', 'hi'), reply('assistant-1', 'Hello'),
      user('user-2', 'look around'), reply('assistant-2', 'Nothing here'),
      user('user-3', 'hi'), reply('assistant-3', 'Hello again'),
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const turnsOf = (adapter: ReturnType<typeof createOmpSuSessionAdapter>, role: string, content: string) => events(adapter)
      .flatMap((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content
        ? [event.turnId] : []);

    // 'turn-live' was delivered live through this adapter, so no replayed
    // prompt may take it; 'hi' then takes turn-a and turn-b in order, and the
    // prompt typed natively (no receipt) keeps an omp: id of its own.
    const receipts = vi.fn(async () => [
      { turnId: 'turn-live', content: 'hi' },
      { turnId: 'turn-a', content: ' hi\n' },
      { turnId: 'turn-b', content: 'hi' },
    ]);
    const ownerTurn = vi.fn<OmpSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const adapter = createOmpSuSessionAdapter(binding(), runtime(THREAD_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-omp-replay-turns', register: false, controls: { ownerTurn }, ownerTurnReceipts: receipts,
    });
    try {
      const live = adapter.host.startCommand(command(adapter, { type: 'owner_turn', commandId: 'owner-live', turnId: 'turn-live', content: 'hi' }));
      await expect(live.terminal).resolves.toMatchObject({ status: 'completed' });
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: THREAD_A }));
      expect(turnsOf(adapter, 'owner', 'hi')).toEqual(['turn-a', 'turn-b']);
      expect(turnsOf(adapter, 'assistant', 'Hello')).toEqual(['turn-a']);
      expect(turnsOf(adapter, 'assistant', 'Hello again')).toEqual(['turn-b']);
      const [native] = turnsOf(adapter, 'owner', 'look around');
      expect(native).toMatch(/^omp:user-2:/);
      expect(turnsOf(adapter, 'assistant', 'Nothing here')).toEqual([native]);
    } finally { adapter.dispose(); }

    // Without receipts (or when reading them fails) every restored prompt
    // still opens its own omp: turn.
    const unmatched = createOmpSuSessionAdapter(binding(), runtime(THREAD_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-omp-replay-turns-unmatched', register: false,
      ownerTurnReceipts: async () => { throw new Error('receipt read failed'); },
    });
    try {
      await unmatched.consumeTranscriptSnapshot({ preserveLifecycle: true });
      const owners = [...turnsOf(unmatched, 'owner', 'hi'), ...turnsOf(unmatched, 'owner', 'look around')];
      expect(owners).toHaveLength(3);
      expect(new Set(owners).size).toBe(3);
      expect(owners.every((turnId) => turnId.startsWith('omp:'))).toBe(true);
    } finally { unmatched.dispose(); }
  });

  it('repairs a stale shared-home attach handle to the tracked per-row OMP home', async () => {
    const returned = runtime(THREAD_A, '/home/test/.omp/agent').nativeSession;
    const resolved = await resolveOmpSuRuntime(binding(returned));
    expect(resolved?.nativeSession.agentHome).toMatch(
      /\/\.papercusp\/su-omp-homes\/session-91\/agent$/,
    );
    expect(resolved?.nativeSession.agentHome).not.toBe('/home/test/.omp/agent');
  });

  it('maps interrupt/resume, preserves identity on replacement, and converges unexpected exit', async () => {
    const interrupt = vi.fn<OmpSuSessionControls['interrupt']>(async () => ({ ok: true }));
    const resume = vi.fn<OmpSuSessionControls['resume']>(async () => ({ ok: true }));
    const adapter = createOmpSuSessionAdapter(binding(), runtime(), { agentChatId: 'agent-chat-omp-reconcile', controls: { interrupt, resume }, register: false });
    try {
      const identity = adapter.host.descriptor().identity;
      const interrupted = adapter.host.startCommand(command(adapter, { type: 'interrupt', commandId: 'interrupt-1', reason: 'owner stop' }));
      await expect(interrupted.terminal).resolves.toMatchObject({ status: 'completed' });
      const resumed = adapter.host.startCommand(command(adapter, { type: 'resume', commandId: 'resume-1', cause: 'runtime-replacement' }));
      await expect(resumed.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(resume).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', threadId: THREAD_A, cause: 'runtime-replacement' });
      adapter.replaceRuntime(runtime(THREAD_B, '/tmp/omp-successor'), 'carry successor attached');
      expect(adapter.host.descriptor()).toMatchObject({ identity, runtimeGeneration: 1, lifecycle: 'ready', backendExtension: { backend: 'omp', agentHome: '/tmp/omp-successor' } });
      adapter.reconcileRuntimeExit({ expected: false, exitCode: 17, signal: null });
      expect(adapter.host.descriptor().lifecycle).toBe('failed');
    } finally { adapter.dispose(); }
  });

  it('maps accepted end and rejects malformed native records without killing the host', async () => {
    const end = vi.fn<OmpSuSessionControls['end']>(async () => ({ ok: true }));
    const adapter = createOmpSuSessionAdapter(binding(), runtime(), { agentChatId: 'agent-chat-omp-end', controls: { end }, register: false });
    try {
      adapter.ingestNativeLine('{not-json');
      expect(events(adapter).some((event) => event.type === 'error' && event.code === 'omp_record_malformed')).toBe(true);
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'end', commandId: 'end-1', reason: 'PUI pane closed' }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(end).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', reason: 'PUI pane closed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ended');
      expect(ompThreadIdFromTranscriptPath(`/tmp/sessions/123_${THREAD_A}.jsonl`)).toBe(THREAD_A);
      expect(ompThreadIdFromTranscriptPath('/tmp/sessions/no-thread.txt')).toBeNull();
    } finally { adapter.dispose(); }
  });

  /**
   * P-006 — "verify ACTUAL model selection" for the OMP leg.
   *
   * Claude reconciles the descriptor from system/init + root assistant records and
   * Codex from `turn_context`; OMP did neither, so an OMP session reported the
   * launch-REQUESTED model for its whole life. That is the worst leg to leave
   * un-reconciled, because OMP is the only backend that records
   * `resolvedModelIsFallback` — it KNOWS when the requested model did not run.
   *
   * Record shapes below are copied from real transcripts under
   * ~/.papercusp/su-omp-homes/session-{17497,18672}/agent/sessions/**.jsonl
   * (two independent sessions, identical shape), not invented for the test:
   *   {"type":"model_change","id":…,"model":"openrouter/stealth/ox-alpha","resolvedModelIsFallback":false}
   *   {"type":"message",…,"message":{"role":"assistant","model":"stealth/ox-alpha",…}}
   * Note the two spellings of the SAME model — that asymmetry is why
   * `model_change` is authoritative and the assistant stamp is only a fallback.
   */
  describe('P-006 actual-model reconciliation', () => {
    const REQUESTED = 'gpt-5.6-omp';
    const RESOLVED = 'openrouter/stealth/ox-alpha';
    const BARE = 'stealth/ox-alpha';

    /**
     * Models named by `session` events that CHANGED the model away from the
     * request, oldest first. The host constructor emits one baseline `session`
     * event carrying the requested model, so a raw event count would measure
     * that baseline rather than the reconciliation under test.
     */
    function modelCorrections(adapter: ReturnType<typeof createOmpSuSessionAdapter>): Array<string | null> {
      return events(adapter)
        .filter((e): e is Extract<typeof e, { type: 'session' }> => e.type === 'session')
        .map((e) => e.descriptor.model)
        .filter((model) => model !== REQUESTED);
    }

    function modelAdapter(agentChatId: string) {
      return createOmpSuSessionAdapter(binding(), runtime(), {
        agentChatId, model: REQUESTED, register: false,
      });
    }

    const modelChange = (model: string) => JSON.stringify({
      type: 'model_change', id: 'ff8a6b5e', parentId: null,
      timestamp: '2026-08-26T08:37:24.082Z', model, resolvedModelIsFallback: false,
    });
    const assistantSay = (model: string | null) => JSON.stringify({
      type: 'message', id: `assistant-${model ?? 'none'}`, timestamp: '2026-08-26T08:37:30.000Z',
      message: { role: 'assistant', ...(model ? { model } : {}), content: [{ type: 'text', text: 'ok' }] },
    });

    it('corrects the descriptor to the model OMP actually resolved', () => {
      const adapter = modelAdapter('agent-chat-omp-model-resolve');
      try {
        expect(adapter.host.descriptor().model).toBe(REQUESTED);
        adapter.ingestNativeLine(modelChange(RESOLVED));
        expect(adapter.host.descriptor().model).toBe(RESOLVED);
        expect(events(adapter).some((e) => e.type === 'session' && e.descriptor.model === RESOLVED)).toBe(true);
      } finally { adapter.dispose(); }
    });

    it('does not flap back to the bare assistant spelling of the same model', () => {
      const adapter = modelAdapter('agent-chat-omp-model-flap');
      try {
        adapter.ingestNativeLine(modelChange(RESOLVED));
        adapter.ingestNativeLine(assistantSay(BARE));
        adapter.ingestNativeLine(assistantSay(BARE));
        expect(adapter.host.descriptor().model).toBe(RESOLVED);
        // Exactly one CORRECTION, not one per assistant message. The host
        // constructor emits its own baseline `session` event carrying the
        // requested model, so count only events that changed the model.
        expect(modelCorrections(adapter)).toEqual([RESOLVED]);
      } finally { adapter.dispose(); }
    });

    it('follows a mid-session model change', () => {
      const adapter = modelAdapter('agent-chat-omp-model-midsession');
      try {
        adapter.ingestNativeLine(modelChange(RESOLVED));
        adapter.ingestNativeLine(assistantSay(BARE));
        adapter.ingestNativeLine(modelChange('openrouter/anthropic/claude-opus-5'));
        expect(adapter.host.descriptor().model).toBe('openrouter/anthropic/claude-opus-5');
      } finally { adapter.dispose(); }
    });

    it('falls back to the assistant stamp when no model_change was ever recorded', () => {
      const adapter = modelAdapter('agent-chat-omp-model-fallback');
      try {
        adapter.ingestNativeLine(assistantSay(BARE));
        expect(adapter.host.descriptor().model).toBe(BARE);
      } finally { adapter.dispose(); }
    });

    /**
     * CALIBRATION — without this, a reconciliation that had degenerated into
     * "always overwrite" or "always null the model" would still pass every case
     * above. A transcript that names no model must leave the request untouched.
     */
    it('leaves the requested model intact when the transcript names no model', () => {
      const adapter = modelAdapter('agent-chat-omp-model-silent');
      try {
        adapter.ingestNativeLine(assistantSay(null));
        adapter.ingestNativeLine(JSON.stringify({ type: 'session', id: THREAD_A, timestamp: '2026-08-26T08:37:23.905Z', cwd: '/workspace' }));
        expect(adapter.host.descriptor().model).toBe(REQUESTED);
        expect(modelCorrections(adapter)).toEqual([]);
      } finally { adapter.dispose(); }
    });
  });
});
