/**
 * session-transcript-resolvers tests — fixture-dir walks for the codex rollout
 * and omp session file resolvers (no real $HOME dependency: both take a root
 * override).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  findCodexLiveThreadId,
  findCodexRolloutPath,
  findCodexRolloutPathByUuid,
  findOmpSessionPath,
  ompAgentHomeForSessionKey,
  ompSessionsRootForSessionKey,
  __resetTranscriptResolverCaches,
  readClosedCodexSessionUsage,
  readClosedCodexRuntimeUsage,
  readClosedClaudeSessionUsage,
  readClosedClaudeRuntimeUsage,
  readClosedClaudeMessageInput,
  readClosedClaudeMessageToolResult,
  readClosedCodexTurnInput,
  readClosedCodexTurnToolResult,
} from './session-transcript-resolvers';

afterEach(() => __resetTranscriptResolverCaches());

describe('source-bound closed Codex input', () => {
  const session = '11111111-2222-3333-4444-555555555555', turn = 'private-input-turn';
  const text = 'Dependency bytes π\nwith their exact whitespace.';
  const source = () => [
    { type: 'session_meta', payload: { id: session } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: '2026-10-11T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'initial context' }, { type: 'input_text', text }] } },
    { type: 'turn_context', payload: { turn_id: turn, model: 'configured-alias' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 } } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
  ];
  async function fixture(fault?: string) {
    const rows = source();
    if (fault === 'foreign-session') rows[0].payload.id = 'foreign-session';
    if (fault === 'foreign-start') rows[1].payload.turn_id = 'foreign-turn';
    if (fault === 'missing-start') rows[1].payload.type = 'unrelated';
    if (fault === 'assistant') rows[2].payload.role = 'assistant';
    if (fault === 'image') rows[2].payload.content![1].type = 'input_image';
    if (fault === 'missing-text') delete (rows[2].payload.content![1] as { text?: string }).text;
    if (fault === 'timestamp') rows[2].timestamp = 'unmeasured';
    if (fault === 'after-close') { const message = rows.splice(2, 1)[0]; rows.push(message); }
    if (fault === 'open-turn') rows.pop();
    const transcript = rows.map(row => JSON.stringify(row) + '\n').join('');
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-source-input-'));
    const dir = join(home, 'sessions', '2026', '10', '11'); await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-11T00-00-00-${session}.jsonl`); await fs.writeFile(file, transcript);
    const calls: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      if (fault === 'source-mutated') await fs.appendFile(file, '{}\n');
      return fault === 'missing-frontier' ? [] : [{ byte_offset: String(Buffer.byteLength(transcript) - (fault === 'partial-frontier' ? 1 : 0)),
        parser_state: { initialized: true, fileGeneration: 0 } }];
    }) as unknown as Sql;
    const binding = { workspaceId: 'private-input-workspace', nativeSessionId: session, codexHome: home,
      nativeTurnId: turn, recordIndex: fault === 'after-close' ? 5 : 2, contentIndex: 1 };
    return { home, file, transcript, sql, binding, calls };
  }
  it('resolves the exact text block before turn_context through native start/closure and the canonical frontier', async () => {
    const f = await fixture();
    try {
      expect(await readClosedCodexTurnInput(f.sql, f.binding)).toEqual({ file: f.file,
        sourceSha256: createHash('sha256').update(f.transcript).digest('hex'), nativeSessionId: session, nativeTurnId: turn,
        recordIndex: 2, contentIndex: 1, at: '2026-10-11T00:00:01.000Z', text });
      expect(f.calls).toEqual([['private-input-workspace', f.file]]);
    } finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
  it.each(['foreign-session', 'foreign-start', 'missing-start', 'assistant', 'image', 'missing-text', 'timestamp',
    'after-close', 'open-turn', 'source-mutated', 'missing-frontier', 'partial-frontier'])
  ('refuses %s input authority', async fault => {
    const f = await fixture(fault);
    try { expect(await readClosedCodexTurnInput(f.sql, f.binding)).toBeNull(); }
    finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
  it('refuses foreign turns and unallocated record/block indices', async () => {
    const f = await fixture();
    try {
      for (const changed of [{ nativeTurnId: 'another-turn' }, { recordIndex: 3 }, { contentIndex: 99 },
        { recordIndex: -1 }, { contentIndex: 1.5 }])
        expect(await readClosedCodexTurnInput(f.sql, { ...f.binding, ...changed })).toBeNull();
    } finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
});

describe('source-bound closed Codex tool results', () => {
  const session = '11111111-2222-3333-4444-555555555555', turn = 'private-tool-turn', callId = 'private-call';
  const args = '{"paths":["private/task.txt"],"intent":"exact π"}', output = '{"ok":false,"busy":["private/task.txt"]}';
  async function fixture(fault?: string) {
    const rows: any[] = [
      { type: 'session_meta', payload: { id: session } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      { timestamp: '2026-10-11T00:00:01Z', type: 'response_item', payload: { type: 'function_call',
        name: 'locks_acquire', namespace: 'mcp', call_id: callId, arguments: args } },
      { timestamp: '2026-10-11T00:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } },
      { type: 'turn_context', payload: { turn_id: turn, model: 'configured-alias' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 } } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
    ];
    if (fault === 'custom') {
      rows[2].payload.type = 'custom_tool_call'; rows[2].payload.input = rows[2].payload.arguments; delete rows[2].payload.arguments;
      rows[3].payload.type = 'custom_tool_call_output'; rows[3].payload.output = [{ type: 'input_text', text: output }];
      rows[3].payload.is_error = true;
    }
    if (fault === 'wrapper') { rows[2].payload.name = 'exec'; rows[2].payload.namespace = 'functions'; }
    if (fault === 'foreign-session') rows[0].payload.id = 'foreign-session';
    if (fault === 'foreign-start') rows[1].payload.turn_id = 'foreign-turn';
    if (fault === 'missing-start') rows[1].payload.type = 'unrelated';
    if (fault === 'call-id') rows[3].payload.call_id = 'foreign-call';
    if (fault === 'foreign-explicit-turn') rows[3].payload.turn_id = 'foreign-turn';
    if (fault === 'output-kind') rows[3].payload.type = 'custom_tool_call_output';
    if (fault === 'name') delete rows[2].payload.name;
    if (fault === 'namespace') rows[2].payload.namespace = {};
    if (fault === 'args') rows[2].payload.arguments = {};
    if (fault === 'output') rows[3].payload.output = {};
    if (fault === 'is-error') rows[3].payload.is_error = 'false';
    if (fault === 'timestamp') rows[3].timestamp = 'unmeasured';
    if (fault === 'reversed-time') rows[3].timestamp = '2026-10-11T00:00:00Z';
    if (fault === 'duplicate-call') rows.splice(4, 0, rows[2]);
    if (fault === 'duplicate-output') rows.splice(4, 0, rows[3]);
    if (fault === 'interrupted') rows.splice(3, 0, { type: 'turn_context', payload: { turn_id: 'foreign-turn' } });
    if (fault === 'after-close') rows.push(rows.splice(3, 1)[0]);
    if (fault === 'open-turn') rows.pop();
    const transcript = rows.map(row => JSON.stringify(row) + '\n').join('');
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-source-tool-'));
    const dir = join(home, 'sessions', '2026', '10', '11'); await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-11T00-00-00-${session}.jsonl`); await fs.writeFile(file, transcript);
    const sql = (async () => {
      if (fault === 'source-mutated') await fs.appendFile(file, '{}\n');
      return fault === 'missing-frontier' ? [] : [{ byte_offset: String(Buffer.byteLength(transcript) - (fault === 'partial-frontier' ? 1 : 0)),
        parser_state: { initialized: true, fileGeneration: 0 } }];
    }) as unknown as Sql;
    const resultRecordIndex = fault === 'interrupted' ? 4 : fault === 'after-close' ? rows.length - 1 : 3;
    return { home, file, transcript, sql, binding: { workspaceId: 'private-tool-workspace', nativeSessionId: session, codexHome: home,
      nativeTurnId: turn, callRecordIndex: 2, resultRecordIndex } };
  }
  it.each(['function', 'custom', 'wrapper'])('preserves exact %s call identity, raw arguments and result', async kind => {
    const f = await fixture(kind);
    try {
      expect(await readClosedCodexTurnToolResult(f.sql, f.binding)).toEqual({ file: f.file,
        sourceSha256: createHash('sha256').update(f.transcript).digest('hex'), nativeSessionId: session, nativeTurnId: turn,
        callRecordIndex: 2, resultRecordIndex: 3, callId, name: kind === 'wrapper' ? 'functions.exec' : 'mcp.locks_acquire',
        arguments: args, output: kind === 'custom' ? [{ type: 'input_text', text: output }] : output,
        callType: kind === 'custom' ? 'custom_tool_call' : 'function_call',
        isError: kind === 'custom' ? true : null, calledAt: '2026-10-11T00:00:01.000Z', at: '2026-10-11T00:00:02.000Z' });
    } finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
  it.each(['foreign-session', 'foreign-start', 'missing-start', 'call-id', 'foreign-explicit-turn', 'output-kind',
    'name', 'namespace', 'args', 'output', 'is-error', 'timestamp', 'reversed-time', 'duplicate-call', 'duplicate-output',
    'interrupted', 'after-close', 'open-turn', 'source-mutated', 'missing-frontier', 'partial-frontier'])
  ('rejects %s tool-result authority', async fault => {
    const f = await fixture(fault);
    try { expect(await readClosedCodexTurnToolResult(f.sql, f.binding)).toBeNull(); }
    finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
  it('refuses foreign turns, reordered and unallocated source ordinals', async () => {
    const f = await fixture();
    try {
      for (const changed of [{ nativeTurnId: 'foreign-turn' }, { callRecordIndex: -1 }, { resultRecordIndex: 3.5 },
        { callRecordIndex: 3 }, { resultRecordIndex: 2 }, { resultRecordIndex: 99 }])
        expect(await readClosedCodexTurnToolResult(f.sql, { ...f.binding, ...changed })).toBeNull();
    } finally { await fs.rm(f.home, { recursive: true, force: true }); }
  });
});

describe('complete closed Codex source accounting', () => {
  const session = '11111111-2222-3333-4444-555555555555';
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const transcript = line({ type: 'session_meta', payload: { id: session } }) +
    line({ type: 'turn_context', payload: { turn_id: 'turn-1', model: 'configured-alias' } }) +
    line({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, output_tokens: 10 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 },
    } } }) + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } });
  async function fixture(run: (input: { home: string; file: string; sql: Sql; calls: unknown[][] }) => Promise<void>,
    frontier: unknown = { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: true, fileGeneration: 0 } }) {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-complete-source-'));
    const dir = join(home, 'sessions', '2026', '10', '09');
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-09T00-00-00-${session}.jsonl`);
    await fs.writeFile(file, transcript);
    const calls: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); return frontier ? [frontier] : []; }) as unknown as Sql;
    try { await run({ home, file, sql, calls }); } finally { await fs.rm(home, { recursive: true, force: true }); }
  }
  const read = (sql: Sql, home: string) => readClosedCodexSessionUsage(sql, { workspaceId: 'bench-private', codexHome: home, nativeSessionId: session });

  it('binds exact native tokens to full bytes and a workspace-scoped canonical frontier without fabricating billed dollars', async () => {
    await fixture(async ({ home, file, sql, calls }) => {
      const result = await read(sql, home);
      expect(result).toMatchObject({ ok: true, file, sourceSha256: createHash('sha256').update(transcript).digest('hex'), nativeTurnIds: ['turn-1'] });
      expect(calls).toEqual([['bench-private', file]]);
      expect(result).not.toHaveProperty('billedInferenceMicros');
      if (result.ok) expect(result.events[0].usage).toMatchObject({ inputTokens: 80, cacheReadTokens: 20, cacheCreationTokens: 0 });
    });
  });
  it.each([false, true])('reads closed usage before retirement with container-relocated home=%s', async relocated => {
    await fixture(async ({ home, file, sql, calls }) => {
      const mounted = home + '-mounted';
      try {
        if (relocated) {
          // The maintained container wrapper moves this exact session directory
          // and leaves its conventional host path as a symlink before launch.
          await fs.rename(home, mounted);
          await fs.symlink(mounted, home);
        }
        const result = await readClosedCodexRuntimeUsage(sql, { workspaceId: 'bench-private', codexHome: home });
        expect(result).toMatchObject({ complete: true, sessions: [{ nativeSessionId: session,
          usage: { ok: true, file, nativeTurnIds: ['turn-1'], events: [{ usage: {
            inputTokens: 80, outputTokens: 10, cacheReadTokens: 20,
          } }] } }] });
        expect(calls).toEqual([['bench-private', file]]);
      } finally {
        if (relocated) await fs.rm(mounted, { recursive: true, force: true });
      }
    });
  });
  it.each(['open turn', 'partial record', 'malformed tail'] as const)('retains the proven closed-turn subtotal with an incomplete %s', async tail => {
    await fixture(async ({ home, file, sql }) => {
      const suffix = tail === 'open turn' ? line({ type: 'turn_context', payload: { turn_id: 'turn-2', model: 'configured-alias' } }) :
        tail === 'partial record' ? '{"type":"event_msg"' : 'unreadable\n';
      await fs.appendFile(file, suffix);
      const result = await read(sql, home);
      expect(result).toMatchObject({ ok: false, knownSubtotal: { ok: true, nativeTurnIds: ['turn-1'],
        closedByteOffset: Buffer.byteLength(transcript), file,
        sourceSha256: createHash('sha256').update(transcript + suffix).digest('hex') } });
      if (!result.ok && result.knownSubtotal) expect(result.knownSubtotal.events[0].usage).toMatchObject({ inputTokens: 80, outputTokens: 10, cacheReadTokens: 20 });
    });
  });
  it('does not infer a known closed subtotal from a frontier before closure', async () => {
    await fixture(async ({ home, sql }) => {
      const result = await read(sql, home);
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty('knownSubtotal');
    }, { byte_offset: String(Buffer.byteLength(transcript) - 1), parser_state: { initialized: true, fileGeneration: 0 } });
  });
  it.each([
    ['missing', null],
    ['partial', { byte_offset: '0', parser_state: { initialized: true } }],
    ['beyond source', { byte_offset: String(Buffer.byteLength(transcript) + 1), parser_state: { initialized: true } }],
    ['uninitialized', { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: false } }],
    ['bootstrap', { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: true, bootstrapOffset: 0 } }],
    ['invalid generation', { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: true, fileGeneration: -1 } }],
  ])('refuses a %s frontier', async (_name, frontier) => {
    await fixture(async ({ home, sql }) => { expect(await read(sql, home)).toMatchObject({ ok: false }); }, frontier);
  });
  it('refuses a source modified during frontier IO', async () => {
    await fixture(async ({ home, file, sql }) => {
      const changing = (async (...args: unknown[]) => {
        const rows = await (sql as unknown as (...args: unknown[]) => Promise<unknown>)(...args);
        await fs.appendFile(file, line({ type: 'response_item', payload: { type: 'message' } }));
        return rows;
      }) as unknown as Sql;
      expect(await read(changing, home)).toMatchObject({ ok: false, detail: expect.stringMatching(/changed/) });
    });
  });
  it('refuses a replaced source even when its byte length is unchanged', async () => {
    await fixture(async ({ home, file, sql }) => {
      const replacing = (async (...args: unknown[]) => {
        const rows = await (sql as unknown as (...args: unknown[]) => Promise<unknown>)(...args);
        await fs.rename(file, file + '.old'); await fs.writeFile(file, transcript);
        return rows;
      }) as unknown as Sql;
      expect(await read(replacing, home)).toMatchObject({ ok: false, detail: expect.stringMatching(/changed/) });
    });
  });
  it('refuses a symlink to source bytes in another runtime', async () => {
    await fixture(async ({ home, file, sql }) => {
      const outside = join(home, 'other-runtime.jsonl');
      await fs.rename(file, outside); await fs.symlink(outside, file);
      expect(await read(sql, home)).toMatchObject({ ok: false });
    });
  });
  it('refuses a redirected sessions directory beneath the host-issued home', async () => {
    await fixture(async ({ home, sql }) => {
      const outside = home + '-foreign-sessions';
      try {
        await fs.rename(join(home, 'sessions'), outside);
        await fs.symlink(outside, join(home, 'sessions'));
        expect(await read(sql, home)).toMatchObject({ ok: false });
      } finally { await fs.rm(outside, { recursive: true, force: true }); }
    });
  });
  it('includes earlier native carry sources rather than returning only the latest session', async () => {
    await fixture(async ({ home, file, sql }) => {
      const old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await fs.writeFile(file.replace(session, old), transcript.replace(session, old));
      const result = await readClosedCodexRuntimeUsage(sql, { workspaceId: 'bench-private', codexHome: home });
      expect(result.complete).toBe(true);
      expect(result.sessions.map(source => source.nativeSessionId)).toEqual([session, old]);
    });
  });
  it.each(['append', 'same-size rewrite'] as const)('refuses completeness when an earlier source changes by %s during a later source read', async change => {
    await fixture(async ({ home, file, sql, calls }) => {
      const old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await fs.writeFile(file.replace(session, old), transcript.replace(session, old));
      const changing = (async (...args: unknown[]) => {
        const rows = await (sql as unknown as (...args: unknown[]) => Promise<unknown>)(...args);
        if (calls.length === 2) {
          if (change === 'append') await fs.appendFile(file, line({ type: 'response_item', payload: { type: 'message' } }));
          else await fs.writeFile(file, transcript.replaceAll('"output_tokens":10', '"output_tokens":20'));
        }
        return rows;
      }) as unknown as Sql;
      const result = await readClosedCodexRuntimeUsage(changing, { workspaceId: 'bench-private', codexHome: home });
      expect(calls).toHaveLength(2);
      expect(result.sessions).toHaveLength(2);
      expect(result.complete).toBe(false);
    });
  });
  it('retains complete sources while marking an open predecessor incomplete', async () => {
    await fixture(async ({ home, file, sql }) => {
      const old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await fs.writeFile(file.replace(session, old), transcript.replace(session, old).trimEnd());
      const result = await readClosedCodexRuntimeUsage(sql, { workspaceId: 'bench-private', codexHome: home });
      expect(result.complete).toBe(false);
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map(source => source.usage.ok)).toEqual([true, false]);
    });
  });
  it('refuses an ambiguous duplicated native session source', async () => {
    await fixture(async ({ home, file, sql }) => {
      await fs.writeFile(file.replace('00-00-00', '01-00-00'), transcript);
      expect(await readClosedCodexRuntimeUsage(sql, { workspaceId: 'bench-private', codexHome: home })).toEqual({ complete: false, sessions: [] });
    });
  });
});

describe('complete closed Claude source accounting', () => {
  const session = '11111111-2222-3333-4444-555555555555';
  const oldSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const transcript = line({ type: 'assistant', sessionId: session, isSidechain: false,
    message: { id: 'msg-source', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } });
  async function fixture(run: (f: { home: string; file: string; sql: Sql; calls: unknown[][] }) => Promise<void>,
    frontier: unknown = { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: true, fileGeneration: 0 } }) {
    const home = await fs.mkdtemp(join(tmpdir(), 'claude-complete-source-'));
    const project = join(home, 'projects', '-task'); await fs.mkdir(project, { recursive: true });
    const file = join(project, `${session}.jsonl`); await fs.writeFile(file, transcript);
    const calls: unknown[][] = [];
    const sql = (async (_s: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); return frontier ? [frontier] : []; }) as unknown as Sql;
    try { await run({ home, file, sql, calls }); } finally { await fs.rm(home, { recursive: true, force: true }); }
  }
  const read = (sql: Sql, home: string) => readClosedClaudeSessionUsage(sql, {
    workspaceId: 'bench-private', claudeConfigDir: home, nativeSessionId: session,
  });
  const runtime = (sql: Sql, home: string) => readClosedClaudeRuntimeUsage(sql, { workspaceId: 'bench-private', claudeConfigDir: home });

  it('binds canonical message tokens to the exact whole source and atomic workspace frontier', async () => {
    await fixture(async ({ home, file, sql, calls }) => {
      const result = await read(sql, home);
      expect(result).toMatchObject({ ok: true, file, sourceSha256: createHash('sha256').update(transcript).digest('hex'),
        nativeMessageIds: ['msg-source'], events: [{ inputTotalTokens: 30, providerResponseId: 'msg-source' }] });
      expect(calls).toEqual([['bench-private', file]]);
      expect(result).not.toHaveProperty('billedInferenceMicros');
    });
  });
  it.each([null, { byte_offset: '1', parser_state: { initialized: true } },
    { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: false } },
    { byte_offset: String(Buffer.byteLength(transcript)), parser_state: { initialized: true, bootstrapOffset: 0 } }])
  ('keeps absent, behind or bootstrap frontiers incomplete: %j', async frontier => {
    await fixture(async ({ home, sql }) => { expect(await read(sql, home)).toMatchObject({ ok: false }); }, frontier);
  });
  it.each(['partial', 'open', 'malformed'] as const)('retains earlier closed messages as a subtotal with a later %s record', async kind => {
    await fixture(async ({ home, file, sql }) => {
      const suffix = kind === 'partial' ? '{"type":"assistant"' : kind === 'malformed' ? 'unreadable\n' :
        line({ type: 'assistant', sessionId: session, message: { id: 'msg-open', model: 'claude-sonnet-4-6', stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      await fs.appendFile(file, suffix);
      expect(await read(sql, home)).toMatchObject({ ok: false, knownSubtotal: { ok: true,
        nativeMessageIds: ['msg-source'], closedByteOffset: Buffer.byteLength(transcript),
        sourceSha256: createHash('sha256').update(transcript + suffix).digest('hex') } });
    });
  });
  it('allows the host-issued home to relocate while rejecting links below it', async () => {
    await fixture(async ({ home, file, sql }) => {
      const mounted = home + '-mounted';
      try {
        await fs.rename(home, mounted); await fs.symlink(mounted, home);
        expect(await runtime(sql, home)).toMatchObject({ complete: true });
        const outside = join(mounted, 'foreign.jsonl'); await fs.rename(file, outside); await fs.symlink(outside, file);
        expect(await read(sql, home)).toMatchObject({ ok: false });
      } finally { await fs.rm(mounted, { recursive: true, force: true }); }
    });
  });
  it('censuses earlier carry sessions and rejects duplicated native identities', async () => {
    await fixture(async ({ home, file, sql }) => {
      await fs.writeFile(file.replace(session, oldSession), transcript.replace(session, oldSession).replace('msg-source', 'msg-oldsrc'));
      const result = await runtime(sql, home);
      expect(result.complete).toBe(true);
      expect(result.sessions.map(s => s.nativeSessionId)).toEqual([session, oldSession]);
      const other = join(home, 'projects', '-other'); await fs.mkdir(other);
      await fs.writeFile(join(other, `${session}.jsonl`), transcript);
      expect(await runtime(sql, home)).toEqual({ complete: false, sessions: [] });
    });
  });
  it.each(['append', 'same-size rewrite'] as const)('refuses an earlier source changing by %s during the census', async change => {
    await fixture(async ({ home, file, sql, calls }) => {
      await fs.writeFile(file.replace(session, oldSession), transcript.replace(session, oldSession).replace('msg-source', 'msg-oldsrc'));
      const changing = (async (...args: unknown[]) => {
        const rows = await (sql as unknown as (...args: unknown[]) => Promise<unknown>)(...args);
        if (calls.length === 2) await (change === 'append' ? fs.appendFile(file, line({ type: 'summary' })) :
          fs.writeFile(file, transcript.replace('"output_tokens":5', '"output_tokens":6')));
        return rows;
      }) as unknown as Sql;
      expect(await runtime(changing, home)).toMatchObject({ complete: false });
      expect(calls).toHaveLength(2);
    });
  });
  it('refuses an unaccounted nested subagent transcript rather than silently excluding its usage', async () => {
    await fixture(async ({ home, sql }) => {
      const nested = join(home, 'projects', '-task', session, 'subagents'); await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(join(nested, 'agent-sub.jsonl'), transcript);
      expect(await runtime(sql, home)).toEqual({ complete: false, sessions: [] });
    });
  });
});

describe('source-bound closed Claude input and tool results', () => {
  const session = '11111111-2222-3333-4444-555555555555';
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const records = (): Array<{ type: string; sessionId: string; uuid: string; parentUuid: string | null;
    timestamp: string; message: { role: string; id?: string; model?: string; stop_reason?: string | null;
      usage?: typeof usage; content: Array<Record<string, unknown>> } }> => [
    { type: 'user', sessionId: session, uuid: 'input-record', parentUuid: null,
      timestamp: '2026-10-24T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Exact dependency π\nbytes.' }] } },
    { type: 'assistant', sessionId: session, uuid: 'call-record', parentUuid: 'input-record',
      timestamp: '2026-10-24T00:00:02Z', message: { role: 'assistant', id: 'msg-call', model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'toolu-exact', name: 'Read', input: { file_path: '/app/input' } }] } },
    { type: 'user', sessionId: session, uuid: 'result-record', parentUuid: 'call-record',
      timestamp: '2026-10-24T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-exact',
        content: 'Exact result\nbytes.', is_error: false }] } },
    { type: 'assistant', sessionId: session, uuid: 'reply-record', parentUuid: 'result-record',
      timestamp: '2026-10-24T00:00:04Z', message: { role: 'assistant', id: 'msg-reply', model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Done.' }] } },
  ];
  async function fixture(run: (f: { readInput: () => ReturnType<typeof readClosedClaudeMessageInput>;
    readTool: () => ReturnType<typeof readClosedClaudeMessageToolResult>; file: string; home: string;
    binding: { -readonly [K in keyof Parameters<typeof readClosedClaudeMessageInput>[1]]:
      Parameters<typeof readClosedClaudeMessageInput>[1][K] }; sql: Sql }) => Promise<void>,
    mutate?: (rows: ReturnType<typeof records>) => void, frontier?: number) {
    const home = await fs.mkdtemp(join(tmpdir(), 'claude-native-evidence-'));
    const project = join(home, 'projects', '-task'); await fs.mkdir(project, { recursive: true });
    const file = join(project, `${session}.jsonl`), rows = records(); mutate?.(rows);
    const transcript = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; await fs.writeFile(file, transcript);
    const sql = (async () => [{ byte_offset: String(frontier ?? Buffer.byteLength(transcript)),
      parser_state: { initialized: true, fileGeneration: 0 } }]) as unknown as Sql;
    const binding = { workspaceId: 'bench-private', nativeSessionId: session, claudeConfigDir: home,
      nativeMessageId: 'msg-reply', messageRecordIndex: 3, recordIndex: 0, contentIndex: 0,
      sourceSha256: createHash('sha256').update(transcript).digest('hex') };
    try { await run({ file, home, binding, sql, readInput: () => readClosedClaudeMessageInput(sql, binding),
      readTool: () => readClosedClaudeMessageToolResult(sql, { ...binding, callRecordIndex: 1, callContentIndex: 0,
        resultRecordIndex: 2, resultContentIndex: 0 }) }); }
    finally { await fs.rm(home, { recursive: true, force: true }); }
  }
  it('reads exact native input ancestry and tool pairing without inventing a native turn', async () => {
    await fixture(async ({ readInput, readTool, binding }) => {
      const input = await readInput(), tool = await readTool();
      expect(input).toMatchObject({ nativeSessionId: session, nativeMessageId: 'msg-reply', recordUuid: 'input-record',
        messageRecordIndex: 3, recordIndex: 0, contentIndex: 0, sourceSha256: binding.sourceSha256,
        at: '2026-10-24T00:00:01.000Z', text: 'Exact dependency π\nbytes.' });
      expect(tool).toMatchObject({ nativeSessionId: session, nativeMessageId: 'msg-reply', callMessageId: 'msg-call',
        callId: 'toolu-exact', name: 'Read', arguments: '{"file_path":"/app/input"}', output: 'Exact result\nbytes.',
        isError: false, calledAt: '2026-10-24T00:00:02.000Z', at: '2026-10-24T00:00:03.000Z' });
      expect(input).not.toHaveProperty('nativeTurnId'); expect(tool).not.toHaveProperty('nativeTurnId');
    });
  });
  it('retains structured tool output and error identity', async () => {
    await fixture(async ({ readTool }) => {
      expect(await readTool()).toMatchObject({ isError: true, output: [{ type: 'text', text: 'Failure detail' }] });
    }, rows => { Object.assign(rows[2].message.content![0], { content: [{ type: 'text', text: 'Failure detail' }], is_error: true }); });
  });
  it.each(['foreign-session', 'sidechain', 'open', 'missing-message', 'broken-parent', 'duplicate-uuid', 'future-parent',
    'wrong-role', 'invalid-time'] as const)('refuses %s message/input authority', async kind => {
    await fixture(async ({ readInput, readTool }) => { expect(await readInput()).toBeNull(); expect(await readTool()).toBeNull(); }, rows => {
      if (kind === 'foreign-session') rows[0].sessionId = 'foreign';
      if (kind === 'sidechain') Object.assign(rows[3], { isSidechain: true });
      if (kind === 'open') Object.assign(rows[3].message, { stop_reason: null });
      if (kind === 'missing-message') rows[3].message.id = 'msg-other';
      if (kind === 'broken-parent') rows[3].parentUuid = 'missing';
      if (kind === 'duplicate-uuid') rows[2].uuid = rows[0].uuid;
      if (kind === 'future-parent') rows[2].parentUuid = 'reply-record';
      if (kind === 'wrong-role') rows[3].message.role = 'user';
      if (kind === 'invalid-time') rows[3].timestamp = 'invalid';
    });
  });
  it.each(['duplicate-call', 'duplicate-result', 'mismatched-call', 'nonobject-input', 'invalid-error', 'reverse-time'] as const)
  ('refuses %s tool authority', async kind => {
    await fixture(async ({ readTool }) => { expect(await readTool()).toBeNull(); }, rows => {
      if (kind === 'duplicate-call') rows[1].message.content!.push({ ...rows[1].message.content![0] });
      if (kind === 'duplicate-result') rows[2].message.content!.push({ ...rows[2].message.content![0] });
      if (kind === 'mismatched-call') Object.assign(rows[2].message.content![0], { tool_use_id: 'toolu-other' });
      if (kind === 'nonobject-input') Object.assign(rows[1].message.content![0], { input: [] });
      if (kind === 'invalid-error') Object.assign(rows[2].message.content![0], { is_error: 'false' });
      if (kind === 'reverse-time') rows[2].timestamp = '2026-10-24T00:00:01Z';
    });
  });
  it('rejects a behind canonical frontier', async () => {
    await fixture(async ({ readInput, readTool }) => { expect(await readInput()).toBeNull(); expect(await readTool()).toBeNull(); }, undefined, 1);
  });
  it.each(['source-hash', 'source-mutation', 'source-link', 'unknown-index'] as const)('rejects %s', async kind => {
    await fixture(async ({ readInput, readTool, binding, file, home }) => {
      if (kind === 'source-hash') binding.sourceSha256 = 'f'.repeat(64);
      if (kind === 'source-mutation') await fs.appendFile(file, JSON.stringify({ type: 'summary' }) + '\n');
      if (kind === 'source-link') { const outside = join(home, 'outside.jsonl'); await fs.rename(file, outside); await fs.symlink(outside, file); }
      if (kind === 'unknown-index') binding.messageRecordIndex = 20;
      expect(await readInput()).toBeNull(); expect(await readTool()).toBeNull();
    });
  });
});

describe('findCodexRolloutPath', () => {
  it('resolves the NEWEST rollout under sessions/<y>/<m>/<d>/ (a resume adds a second file)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-home-'));
    const day = join(home, 'sessions', '2026', '06', '26');
    await fs.mkdir(day, { recursive: true });
    const older = join(day, 'rollout-2026-06-26T06-08-50-aaa.jsonl');
    const newer = join(day, 'rollout-2026-06-26T09-00-00-bbb.jsonl');
    await fs.writeFile(older, '{}\n');
    await fs.writeFile(newer, '{}\n');
    await fs.utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    try {
      expect(await findCodexRolloutPath('9999', { homeOverride: home })).toBe(newer);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('null when the home has no sessions dir yet (pre-first-turn), found once written', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-empty-'));
    try {
      expect(await findCodexRolloutPath('8888', { homeOverride: home })).toBeNull();
      // The transcript appears (codex takes its first turn) → next resolve sees it
      // (misses are deliberately NOT cached — the endpoint polls for this).
      const day = join(home, 'sessions', '2026', '07', '01');
      await fs.mkdir(day, { recursive: true });
      const p = join(day, 'rollout-2026-07-01T00-00-00-ccc.jsonl');
      await fs.writeFile(p, '{}\n');
      expect(await findCodexRolloutPath('8888', { homeOverride: home })).toBe(p);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('findCodexLiveThreadId', () => {
  it('resolves the newest real thread-writer lock before any rollout exists', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-live-thread-'));
    const locks = join(home, 'thread-writer-locks');
    await fs.mkdir(locks, { recursive: true });
    const older = '01a04fe7-9310-7f81-8bcf-0887a91a811b';
    const newer = '01a05001-07fb-72c3-a65d-4b7ad0c5f55a';
    await fs.writeFile(join(locks, `${older}.lock`), '');
    await fs.writeFile(join(locks, '.coordination.lock'), '');
    await fs.writeFile(join(locks, 'not-a-thread.lock'), '');
    await fs.writeFile(join(locks, `${newer}.lock`), '');
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(join(locks, `${older}.lock`), stale, stale);
    try {
      expect(await findCodexLiveThreadId(home)).toBe(newer);
      expect(await findCodexRolloutPath('pre-turn', { homeOverride: home })).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('returns null rather than treating coordination or malformed locks as native ids', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-no-thread-'));
    const locks = join(home, 'thread-writer-locks');
    await fs.mkdir(locks, { recursive: true });
    await fs.writeFile(join(locks, '.coordination.lock'), '');
    await fs.writeFile(join(locks, 'pending.lock'), '');
    try {
      expect(await findCodexLiveThreadId(home)).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('findOmpSessionPath', () => {
  it('uses the isolated operator root for tracked handles and transcript lookup', () => {
    vi.stubEnv('PAPERCUSP_SU_OMP_HOMES_DIR', '/tmp/isolated-omp');
    try {
      expect(ompAgentHomeForSessionKey(42, '/home/test')).toBe('/tmp/isolated-omp/session-42/agent');
      expect(ompSessionsRootForSessionKey(42, '/home/test')).toBe('/tmp/isolated-omp/session-42/agent/sessions');
      expect(ompAgentHomeForSessionKey(undefined, '/home/test')).toBe('/home/test/.omp/agent');
    } finally { vi.unstubAllEnvs(); }
  });

  it('routes tracked sessions to their isolated OMP home and untracked sessions to the shared home', () => {
    expect(ompAgentHomeForSessionKey(42, '/home/test')).toBe(
      '/home/test/.papercusp/su-omp-homes/session-42/agent',
    );
    expect(ompAgentHomeForSessionKey(undefined, '/home/test')).toBe(
      '/home/test/.omp/agent',
    );
    expect(ompSessionsRootForSessionKey(42, '/home/test')).toBe(
      '/home/test/.papercusp/su-omp-homes/session-42/agent/sessions',
    );
    expect(ompSessionsRootForSessionKey(undefined, '/home/test')).toBe(
      '/home/test/.omp/agent/sessions',
    );
  });

  it('resolves by _<threadId>.jsonl suffix across cwd dirs; rejects malformed ids', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'omp-root-'));
    const dir = join(root, '-home-x-proj');
    await fs.mkdir(dir, { recursive: true });
    const tid = '019f1de3-19b8-7000-90a3-a36f8c343ac6';
    const target = join(dir, `2026-07-01T13-34-10-360Z_${tid}.jsonl`);
    await fs.writeFile(target, '{}\n');
    try {
      expect(await findOmpSessionPath(tid, { rootOverride: root })).toBe(target);
      expect(await findOmpSessionPath('zzzz-not-there-1234', { rootOverride: root })).toBeNull();
      expect(await findOmpSessionPath('../..', { rootOverride: root })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * WI-6794 — the positive-resolution cache must key on the ROOT it searched.
 *
 * Every resolver here takes a home/root override, so a cache keyed by session
 * id alone hands one home's answer to a caller that asked about a different
 * one. The existing staleness guard cannot catch that: it only re-stats the
 * cached path, and that path still exists — under the wrong root. Found by
 * WI-6581's live probe, where a homeOverride hit made a later default lookup
 * report a rollout that is not in the default home at all.
 */
describe('WI-6794: a cached resolution never leaks across roots', () => {
  const UUID = '019f713e-8fa2-7d52-9cbc-29644c273d4f';

  /** `<home>/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl` — the real shape. */
  async function seedCodex(home: string, uuid: string): Promise<string> {
    const day = join(home, 'sessions', '2026', '08', '01');
    await fs.mkdir(day, { recursive: true });
    const p = join(day, `rollout-2026-08-01T00-00-00-${uuid}.jsonl`);
    await fs.writeFile(p, '{}\n');
    return p;
  }

  async function twoHomes(): Promise<[string, string]> {
    return [
      await fs.mkdtemp(join(tmpdir(), 'resolv-a-')),
      await fs.mkdtemp(join(tmpdir(), 'resolv-b-')),
    ];
  }

  it('findCodexRolloutPathByUuid does not serve home A\'s hit to a home B lookup', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      // B genuinely has no rollout for this uuid. Pre-fix this returned A's
      // path straight from the cache, having never walked B at all.
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBeNull();
      // …and A still resolves, i.e. the fix did not just disable the cache.
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('returns each root\'s OWN file when BOTH hold the same uuid, in either order', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      const inB = await seedCodex(b, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBe(inB);
      __resetTranscriptResolverCaches();
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBe(inB);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('findCodexRolloutPath (adv-row session key) is root-scoped too', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPath('13354', { homeOverride: a })).toBe(inA);
      expect(await findCodexRolloutPath('13354', { homeOverride: b })).toBeNull();
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('findOmpSessionPath is root-scoped too', async () => {
    const [a, b] = await twoHomes();
    const tid = '019f1de3-19b8-7000-90a3-a36f8c343ac6';
    try {
      const dir = join(a, '-home-x-proj');
      await fs.mkdir(dir, { recursive: true });
      const inA = join(dir, `2026-08-01T00-00-00-000Z_${tid}.jsonl`);
      await fs.writeFile(inA, '{}\n');
      expect(await findOmpSessionPath(tid, { rootOverride: a })).toBe(inA);
      expect(await findOmpSessionPath(tid, { rootOverride: b })).toBeNull();
      expect(await findOmpSessionPath(tid, { rootOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('a cached path whose file is GONE is dropped, not served', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      await fs.rm(inA);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBeNull();
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });
});

/**
 * EI-20219088862022620 / WI-38090 — the recurrence guard for a CLASS that had been
 * filed three times (WI-5075, EI-16310, EI-20219088862022620) with no closure ever
 * leaving a test that fails when it returns: "the compaction watchdog's context
 * estimate is pinned to a DEAD PREDECESSOR transcript and never tracks the live
 * successor."
 *
 * The 2026-08-12 instance was NOT in the watchdog at all — it was here. `codexPathCache`
 * is keyed by the adv-session id, which is STABLE across carry-respawns (a respawn reuses
 * the same adv row and the same per-session CODEX_HOME) while the rollout FILE changes on
 * every respawn. The cache was invalidated only when the cached file was DELETED, and
 * rollouts are never deleted — so the first resolution was pinned for the life of the
 * process and every successor generation was invisible. Downstream, coord_presence
 * .context_tokens froze at a dead session's final reading while context_estimated_at kept
 * refreshing, 48 live sessions were reported over their ceiling (one at 2.7× its true
 * usage), and the WI-5075 respawn-streak guard read "the estimate never drops" as grounds
 * to permanently suppress BOTH enforcement rungs, leaving real sessions to run into
 * "Prompt is too long".
 *
 * The pre-existing "resolves the NEWEST rollout" test above could not catch it: it
 * resolves ONCE against a cold cache, which is the only state in which the old code was
 * correct. The defect only exists on the SECOND resolution, so the guard has to make two.
 */
describe('EI-20219088862022620: a per-home resolution follows a carry-respawn to the new rollout', () => {
  /** Successive rollout generations in ONE codex home — what a carry-respawn produces. */
  async function seedGeneration(home: string, name: string, ageMs = 0): Promise<string> {
    const day = join(home, 'sessions', '2026', '08', '12');
    await fs.mkdir(day, { recursive: true });
    const p = join(day, `rollout-${name}.jsonl`);
    await fs.writeFile(p, '{}\n');
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(p, t, t);
    }
    return p;
  }

  it('returns the SUCCESSOR rollout once the cached resolution expires (the pinning bug)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-respawn-'));
    try {
      const predecessor = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      const t0 = 1_000_000;
      // The watchdog's first sweep resolves — and CACHES — the predecessor.
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 })).toBe(
        predecessor,
      );

      // The watchdog carry-respawns the session. Codex writes a NEW rollout into the SAME
      // home; the predecessor is left on disk forever, which is exactly why an
      // existence-only guard cannot notice. The adv-session key does not change.
      const successor = await seedGeneration(home, '2026-08-12T00-22-17-gen3');

      // A later sweep MUST estimate from the successor. Before the fix this returned the
      // predecessor for the life of the process — a dead session's frozen context size
      // reported as the live successor's usage.
      expect(
        await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 + 11_000 }),
      ).toBe(successor);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('still serves the cached path WITHIN the TTL (the repeat-open win is not thrown away)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-ttl-'));
    try {
      const first = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      const t0 = 2_000_000;
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 })).toBe(first);
      await seedGeneration(home, '2026-08-12T00-22-17-gen3');
      // One sweep calls this several times for the same owner (estimate, window, carry-spec
      // build); those must not each re-walk the home.
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 + 500 })).toBe(
        first,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  /**
   * FALSIFIABILITY CONTROL (repo discipline: "a guard test that has never failed is a
   * guard you have not tested"). The subject is a module we import, so the tier-1 form
   * applies — a deliberately-wrong implementation kept PERMANENTLY here, never a
   * mutation of the shared tree (a probe that edits in-tree can be committed by the
   * git-sync sweep even when nothing goes wrong).
   *
   * This is the EXACT pre-fix guard: cache the resolution, and re-serve it whenever the
   * cached file still exists. It is what shipped, and it is why the bug was invisible —
   * every individual step of it looks reasonable.
   */
  it('CONTROL: the pre-fix existence-only guard stays pinned to the predecessor', async () => {
    const cache = new Map<string, string>();
    async function resolveWithExistenceOnlyCache(key: string, home: string) {
      const cached = cache.get(key);
      if (cached) {
        // The old invalidation rule, verbatim: does the cached file still exist?
        try {
          await fs.stat(cached);
          return cached;
        } catch {
          cache.delete(key);
        }
      }
      const fresh = await findCodexRolloutPath(key, { homeOverride: home, nowMs: Date.now() });
      if (fresh) cache.set(key, fresh);
      return fresh;
    }

    const home = await fs.mkdtemp(join(tmpdir(), 'codex-control-'));
    try {
      __resetTranscriptResolverCaches();
      const predecessor = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      expect(await resolveWithExistenceOnlyCache('14976', home)).toBe(predecessor);

      __resetTranscriptResolverCaches(); // isolate: only the CONTROL's cache is under test
      const successor = await seedGeneration(home, '2026-08-12T00-22-17-gen3');

      // The successor exists and is newest, and the control still hands back the dead one.
      // If this assertion ever flips to toBe(successor), the control has stopped modelling
      // the bug and the guard above is no longer known to discriminate.
      expect(await resolveWithExistenceOnlyCache('14976', home)).toBe(predecessor);
      expect(await resolveWithExistenceOnlyCache('14976', home)).not.toBe(successor);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('the UUID leg keeps its no-TTL cache — its key names one FILE, not a home to search', async () => {
    // Guards the distinction the fix rests on: blanket-TTLing every cache would be a
    // pointless re-walk here, because a uuid-keyed answer cannot move while the file lives.
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-uuid-ttl-'));
    const uuid = '019ff420-ebbd-7861-83c2-f5c7f04f4cc1';
    try {
      const day = join(home, 'sessions', '2026', '08', '12');
      await fs.mkdir(day, { recursive: true });
      const p = join(day, `rollout-2026-08-12T00-00-26-${uuid}.jsonl`);
      await fs.writeFile(p, '{}\n');
      expect(await findCodexRolloutPathByUuid(uuid, { homeOverride: home })).toBe(p);
      expect(await findCodexRolloutPathByUuid(uuid, { homeOverride: home })).toBe(p);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// NOTE (WI-6794): a NUL byte from a mistyped template-literal separator landed
// in this exact module while fixing the cache key, and it is invisible in an
// editor while silently making grep/rg report "binary file matches". I started
// to add a per-file NUL assertion here — and then found the class is ALREADY
// guarded tree-wide by `npm run lint:no-control-bytes`
// (scripts/check-no-control-bytes.mjs, EI-7432, the identical incident), which
// scans every tracked source file and runs in CI. A per-file copy of an
// existing repo-wide guard is the duplication this repo's reuse-first rule
// exists to prevent, so there is deliberately no assertion here. To diagnose
// the symptom by hand: `tr -dc '\000' < FILE | wc -c`.
