import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advSessionIdFromCodexHome,
  codexSessionIdForFile,
  codexSessionRoots,
  closedCodexTurnPopulation,
  closedCodexSessionPopulation,
  defaultAdapters,
  parseCodexChunk,
  parseOmpChunk,
  providerForModel,
  UNKNOWN_CODEX_MODEL,
} from './ingest-adapters';

const codexLine = (o: unknown) => JSON.stringify(o) + '\n';

describe('closed Codex session accounting population', () => {
  const header = codexLine({ type: 'session_meta', payload: { id: 'native-1' } });
  const context = (id: string) => codexLine({ type: 'turn_context', payload: { turn_id: id, model: 'gpt-6' } });
  const usage = (n: number, changed: Record<string, unknown> = {}) => codexLine({ type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 10 },
      last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 5, ...changed } },
  } });
  const close = (id: string) => codexLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } });
  const first = header + context('turn-1') + usage(100) + usage(100) + close('turn-1');
  const read = (transcript: string) => closedCodexSessionPopulation({ transcript,
    file: '/host/sessions/rollout-native-1.jsonl', fileGeneration: 0, nativeSessionId: 'native-1' });

  it('covers every closed turn and request with the canonical deduplication and cache breakdown', () => {
    const transcript = first + context('turn-2') + usage(200) + close('turn-2');
    const result = read(transcript);
    expect(result).toMatchObject({ ok: true, nativeTurnIds: ['turn-1', 'turn-2'], closedByteOffset: Buffer.byteLength(transcript) });
    if (!result.ok) throw new Error(result.detail);
    expect(result.events).toHaveLength(2);
    expect(result.usageEventKeys).toHaveLength(2);
    expect(result.events.map(event => event.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(result.events[0].usage).toMatchObject({ inputTokens: 75, cacheReadTokens: 20, cacheCreationTokens: 5, outputTokens: 10 });
    const turn = closedCodexTurnPopulation({ transcript,
      file: '/host/sessions/rollout-native-1.jsonl', fileGeneration: 0, nativeSessionId: 'native-1', nativeTurnId: 'turn-1' });
    expect(turn.ok).toBe(true);
    if (turn.ok) expect(result.events[0].usageEventKey).toBe(turn.usageEventKeys[0]);
  });

  it.each([
    ['open later turn', first + context('turn-2') + usage(200)],
    ['missing earlier closure', header + context('turn-1') + usage(100) + context('turn-2') + usage(200) + close('turn-2')],
    ['usage outside a turn', header + usage(100)],
    ['usage after closure', first + usage(200)],
    ['wrong closure', header + context('turn-1') + usage(100) + close('wrong-turn')],
    ['reopened turn', first + context('turn-1') + usage(200) + close('turn-1')],
    ['unreported cache write', header + context('turn-1') + usage(100, { cache_write_input_tokens: undefined }) + close('turn-1')],
    ['unreported cache read', header + context('turn-1') + usage(100, { cached_input_tokens: undefined }) + close('turn-1')],
    ['impossible cache subsets', header + context('turn-1') + usage(100, { cached_input_tokens: 99 }) + close('turn-1')],
    ['invalid token count', header + context('turn-1') + usage(100, { output_tokens: -1 }) + close('turn-1')],
    ['conflicting duplicate', header + context('turn-1') + usage(100) + usage(100, { output_tokens: 20 }) + close('turn-1')],
    ['cross-turn duplicate identity', first + context('turn-2') + usage(100) + close('turn-2')],
    ['partial source', first.trimEnd()],
  ])('keeps %s incomplete rather than emitting a complete cost population', (_name, transcript) => {
    expect(read(transcript)).toMatchObject({ ok: false });
  });
});

describe('closed Codex monetary population', () => {
  const header = codexLine({ type: 'session_meta', payload: { id: 'native-1' } });
  const context = (id = 'turn-1') => codexLine({ type: 'turn_context', payload: { turn_id: id, model: 'gpt-6' } });
  const usage = (n = 100) => codexLine({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: n, output_tokens: 10 },
    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0 },
  } } });
  const close = (id = 'turn-1') => codexLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } });
  const read = (transcript: string, fileGeneration = 0) => closedCodexTurnPopulation({ transcript,
    file: '/host/sessions/rollout-native-1.jsonl', fileGeneration, nativeSessionId: 'native-1', nativeTurnId: 'turn-1' });

  it('derives the full distinct population independently of ingested rows and excludes later turns', () => {
    const prefix = header + context() + usage() + usage() + usage(200) + close();
    const result = read(prefix + context('turn-2') + usage(300) + close('turn-2'));
    expect(result).toMatchObject({ ok: true, closedByteOffset: Buffer.byteLength(prefix) });
    if (!result.ok) throw new Error(result.detail);
    expect(result.usageEventKeys).toHaveLength(2);
    expect(new Set(result.usageEventKeys).size).toBe(2);
    expect(read(prefix, 1)).not.toEqual(read(prefix));
  });

  it.each([
    ['partial tail', header + context() + usage() + close().trimEnd()],
    ['missing prefix', context() + usage() + close()],
    ['different session', header.replace('native-1', 'foreign') + context() + usage() + close()],
    ['unreadable record', header + context() + '{bad-json}\n' + usage() + close()],
    ['missing turn context', header + usage() + close()],
    ['uncorrelated close', header + context() + usage() + close('other')],
    ['empty turn', header + context() + close()],
    ['premature switch', header + context() + usage() + context('other') + close()],
    ['reopened turn', header + context() + usage() + close() + context() + usage(200)],
    ['usage after closure', header + context() + usage() + close() + usage(200)],
    ['duplicate closure', header + context() + usage() + close() + close()],
    ['duplicate header', header + header + context() + usage() + close()],
    ['missing model', header + context().replace(',"model":"gpt-6"', '') + usage() + close()],
    ['no cumulative identity', header + context() + codexLine({ type: 'event_msg', payload: { type: 'token_count',
      info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } }) + close()],
    ['fractional identity', header + context() + usage(0.1) + close()],
  ])('refuses %s rather than inventing complete billing evidence', (_label, transcript) => {
    expect(read(transcript)).toMatchObject({ ok: false });
  });

  it('counts interrupted native turns with reported usage and ignores rate-limit-only notifications', () => {
    const rateLimit = codexLine({ type: 'event_msg', payload: { type: 'token_count', info: null } });
    expect(read(header + context() + rateLimit + usage() + close().replace('task_complete', 'turn_completed')))
      .toMatchObject({ ok: true, usageEventKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
    expect(read(header + context() + rateLimit + close())).toMatchObject({ ok: false });
    expect(read(header + context() + usage() + close(), -1)).toMatchObject({ ok: false });
  });
});

describe('parseCodexChunk (P-015)', () => {
  const turnCtx = codexLine({
    timestamp: '2026-06-01T09:56:20.343Z',
    type: 'turn_context',
    payload: { turn_id: 't-1', model: 'gpt-5.5', effort: 'high' },
  });
  const tokenCount = (input: number, cached: number, output: number) =>
    codexLine({
      timestamp: '2026-06-01T09:56:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
          last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output },
        },
      },
    });

  const nativeIdentity = (changed: Record<string, unknown> = {}) => codexLine({ type: 'token_usage_record', payload: {
    session_id: 'native-1', thread_id: 'native-1', turn_id: 't-1', response_id: 'resp-exact',
    thread_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
    usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 },
    ...changed,
  } });
  const nativeHeader = codexLine({ type: 'session_meta', payload: { id: 'native-1' } });

  it('adds the exact provider response identity without changing request keys, totals or counts', () => {
    const legacy = parseCodexChunk(nativeHeader + turnCtx + tokenCount(100, 20, 10));
    const enriched = parseCodexChunk(nativeHeader + turnCtx + nativeIdentity() + tokenCount(100, 20, 10) + tokenCount(100, 20, 10));
    expect(enriched.events).toHaveLength(1);
    expect(enriched.events![0]).toMatchObject({ providerResponseId: 'resp-exact', sourceId: legacy.events![0].sourceId,
      usage: legacy.events![0].usage, requestOrdinal: 1 });
    expect(enriched.perModel).toEqual(legacy.perModel);
    expect(legacy.events![0].providerResponseId).toBeUndefined();
  });

  it('preserves a pending native identity through a serialized parser restart', () => {
    const first = parseCodexChunk(nativeHeader + turnCtx + nativeIdentity());
    expect(first.events).toEqual([]);
    const next = parseCodexChunk(tokenCount(100, 20, 10), JSON.parse(JSON.stringify(first.parserState)));
    expect(next.events![0]).toMatchObject({ providerResponseId: 'resp-exact', requestOrdinal: 1 });
    expect(next.parserState?.pendingCodexUsageIdentity).toBeUndefined();
  });

  it.each([
    { session_id: 'another-session' }, { thread_id: 'another-thread' }, { turn_id: 'another-turn' },
    { response_id: '' }, { response_id: 'bad\nidentity' }, { response_id: 'x'.repeat(513) },
    { thread_token_usage: { input_tokens: 101, cached_input_tokens: 20, output_tokens: 10 } },
    { usage: { input_tokens: 101, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 } },
  ])('leaves a mismatched native identity unknown: %j', (changed) => {
    const parsed = parseCodexChunk(nativeHeader + turnCtx + nativeIdentity(changed) + tokenCount(100, 20, 10));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events![0].providerResponseId).toBeUndefined();
    expect(parsed.perModel.get('gpt-5.5')?.turns).toBe(1);
  });

  it('requires an observed native session header and consumes identity on a nonmatching count', () => {
    expect(parseCodexChunk(turnCtx + nativeIdentity() + tokenCount(100, 20, 10)).events![0].providerResponseId).toBeUndefined();
    const parsed = parseCodexChunk(nativeHeader + turnCtx + nativeIdentity() + tokenCount(101, 20, 10) + tokenCount(100, 20, 10));
    expect(parsed.events!.map(event => event.providerResponseId)).toEqual([undefined, undefined]);
  });

  it('does not carry a pending response identity over turn or compaction boundaries', () => {
    for (const boundary of [turnCtx, codexLine({ type: 'compacted' })]) {
      const parsed = parseCodexChunk(nativeHeader + turnCtx + nativeIdentity() + boundary + tokenCount(100, 20, 10));
      expect(parsed.events![0].providerResponseId).toBeUndefined();
    }
  });

  it('attributes only explicit native user-message envelopes and retires them at the next turn', () => {
    const user = (text: string) => codexLine({ type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text }] } });
    const first = parseCodexChunk(nativeHeader + user('⟦turn-origin:loop-fire nonce:1234567890abcdef⟧\ncontinue'));
    const next = parseCodexChunk(turnCtx + tokenCount(100, 20, 10), JSON.parse(JSON.stringify(first.parserState)));
    expect(next.events![0].turnTrigger).toBe('loop-fire');
    const active = parseCodexChunk(tokenCount(101, 20, 10), JSON.parse(JSON.stringify(next.parserState)));
    expect(active.events![0].turnTrigger).toBe('loop-fire');
    const plain = parseCodexChunk(user('continue the work') + turnCtx + tokenCount(102, 20, 10), active.parserState);
    expect(plain.events![0].turnTrigger).toBeUndefined();
    const absent = parseCodexChunk(turnCtx + tokenCount(103, 20, 10), active.parserState);
    expect(absent.events![0].turnTrigger).toBeUndefined();
    const quote = parseCodexChunk(user('A quoted example: ⟦turn-origin:loop-fire nonce:1234567890abcdef⟧') + turnCtx + tokenCount(100, 20, 10));
    expect(quote.events![0].turnTrigger).toBeUndefined();
  });

  it('sums last_token_usage per token_count event under the turn_context model', () => {
    const { perModel, consumedBytes } = parseCodexChunk(turnCtx + tokenCount(17550, 9600, 14) + tokenCount(2000, 1500, 50));
    expect(consumedBytes).toBeGreaterThan(0);
    const d = perModel.get('gpt-5.5')!;
    expect(d.turns).toBe(2);
    // input INCLUDES the cached subset → uncached = input − cached.
    expect(d.inputTokens).toBe(17550 - 9600 + (2000 - 1500));
    expect(d.cacheReadTokens).toBe(9600 + 1500);
    expect(d.outputTokens).toBe(64);
    expect(d.cacheCreationTokens).toBe(0);
  });

  it('rate-limit-only token_count (info null) contributes nothing', () => {
    const rlOnly = codexLine({ type: 'event_msg', payload: { type: 'token_count', info: null } });
    const { perModel } = parseCodexChunk(turnCtx + rlOnly);
    expect(perModel.size).toBe(0);
  });

  it('keeps the model unknown when no observed turn_context precedes usage', () => {
    const { perModel } = parseCodexChunk(tokenCount(100, 0, 10));
    expect([...perModel.keys()]).toEqual([UNKNOWN_CODEX_MODEL]);
    expect(providerForModel(UNKNOWN_CODEX_MODEL)).toBe('openai');
  });

  it('preserves the native turn identity across chunks without inventing a trigger', () => {
    const first = parseCodexChunk(turnCtx);
    const second = parseCodexChunk(tokenCount(1000, 600, 40), JSON.parse(JSON.stringify(first.parserState)));
    expect(second.events?.[0].turnId).toBe('t-1');
    expect(second.parserState?.turnId).toBe('t-1');
    const sparse = parseCodexChunk(codexLine({ type: 'turn_context', payload: { turn_id: 't-2' } }) + tokenCount(2000, 600, 40), second.parserState);
    expect(sparse.events?.[0]).toMatchObject({ turnId: 't-2', model: 'gpt-5.5' });
  });

  it('preserves an observed model across a chunk boundary and a serialized restart', () => {
    const first = parseCodexChunk(codexLine({ type: 'turn_context', payload: { model: 'gpt-6-luna' } }));
    const persisted = JSON.parse(JSON.stringify(first.parserState));
    const second = parseCodexChunk(tokenCount(1000, 600, 40), persisted);
    expect([...second.perModel.keys()]).toEqual(['gpt-6-luna']);
    expect(second.perModel.get('gpt-6-luna')?.inputTokens).toBe(400);
    expect(persisted).toEqual({ model: 'gpt-6-luna', attributionStateVersion: 1 }); // parsing does not mutate the committed state
  });

  it('updates the model when the source changes it, without relabeling earlier usage', () => {
    const chunk = turnCtx + tokenCount(1000, 600, 40) +
      codexLine({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) + tokenCount(2000, 1500, 60);
    const parsed = parseCodexChunk(chunk);
    expect([...parsed.perModel.keys()]).toEqual(['gpt-5.5', 'gpt-6-astra']);
    expect(parsed.parserState?.model).toBe('gpt-6-astra');
  });

  it('deduplicates repeated cumulative usage across chunks but counts distinct requests with identical last usage', () => {
    const event = tokenCount(1000, 600, 40);
    const first = parseCodexChunk(turnCtx + event + event);
    expect(first.perModel.get('gpt-5.5')?.turns).toBe(1);
    const second = parseCodexChunk(event, JSON.parse(JSON.stringify(first.parserState)));
    expect(second.perModel.size).toBe(0);
    const next = JSON.parse(event);
    next.payload.info.total_token_usage = { input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 80 };
    expect(parseCodexChunk(codexLine(next), second.parserState).perModel.get('gpt-5.5')?.turns).toBe(1);
  });

  it('ignores zero-usage resets and records sparse fork lineage without guessing its model', () => {
    const parsed = parseCodexChunk(
      codexLine({ type: 'session_meta', payload: { forked_from_id: 'parent-session' } }) +
      tokenCount(0, 0, 0) + codexLine({ type: 'compacted' }) + tokenCount(1000, 600, 40),
    );
    expect(parsed.perModel.get(UNKNOWN_CODEX_MODEL)?.turns).toBe(1);
    expect(parsed.parserState).toMatchObject({ predecessorSessionId: 'parent-session', contextGeneration: 1 });
    expect(parsed.parserState?.model).toBeUndefined();
  });

  it('recovers managed-carry lineage from the native Codex user-message content shape', () => {
    const predecessor = '01a0d5cb-6245-7692-a1a5-215c88d10295';
    const header = codexLine({ type: 'session_meta', payload: { id: 'successor-session' } });
    const carryMessage = codexLine({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'carried context\n⟦codex-carry-lineage predecessor:' + predecessor + '⟧\nrecovery details',
        }],
      },
    });
    const first = parseCodexChunk(header + turnCtx + carryMessage);
    expect(first.parserState?.predecessorSessionId).toBe(predecessor);

    const resumed = parseCodexChunk(tokenCount(1000, 600, 40), JSON.parse(JSON.stringify(first.parserState)));
    expect(resumed.events?.[0]).toMatchObject({
      requestOrdinal: 1,
      contextGeneration: 0,
      predecessorSessionId: predecessor,
    });
  });

  it('keeps native fork metadata authoritative when it conflicts with a carry marker', () => {
    const nativePredecessor = 'native-parent-session';
    const markerPredecessor = '01a0d5cb-6245-7692-a1a5-215c88d10295';
    const carryMessage = codexLine({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '⟦codex-carry-lineage predecessor:' + markerPredecessor + '⟧',
        }],
      },
    });
    const parsed = parseCodexChunk(
      codexLine({ type: 'session_meta', payload: { forked_from_id: nativePredecessor } }) +
      carryMessage + tokenCount(1000, 600, 40),
    );
    expect(parsed.parserState?.predecessorSessionId).toBe(nativePredecessor);
    expect(parsed.events?.[0].predecessorSessionId).toBe(nativePredecessor);
  });

  it('counts startup requests across serialized chunks without counting duplicate/reset notifications', () => {
    const header = codexLine({ type: 'session_meta', payload: { forked_from_id: 'parent' } });
    const first = parseCodexChunk(header + turnCtx + tokenCount(700000, 0, 1));
    expect(first.events?.[0]).toMatchObject({ requestOrdinal: 1, contextGeneration: 0, predecessorSessionId: 'parent' });
    const second = parseCodexChunk(tokenCount(700000, 0, 1) + tokenCount(0, 0, 0) + tokenCount(690000, 2816, 2),
      JSON.parse(JSON.stringify(first.parserState)));
    expect(second.events).toHaveLength(1);
    expect(second.events?.[0]).toMatchObject({ requestOrdinal: 2, contextGeneration: 0 });
    const third = parseCodexChunk(codexLine({ type: 'compacted' }) + tokenCount(90000, 8000, 3), second.parserState);
    expect(third.events?.[0]).toMatchObject({ requestOrdinal: 3, contextGeneration: 1 });
    const partial = parseCodexChunk(turnCtx + tokenCount(700000, 0, 1));
    expect(partial.events?.[0].requestOrdinal).toBeUndefined();
    expect(partial.events?.[0].contextGeneration).toBeUndefined();
  });

  it('does not certify startup ordinals without request identity or missing cache reads as reported zero', () => {
    const header = codexLine({ type: 'session_meta', payload: {} });
    const event = JSON.parse(tokenCount(700000, 0, 1));
    delete event.payload.info.last_token_usage.cached_input_tokens;
    expect(parseCodexChunk(header + codexLine(event)).events?.[0].cacheReadKnown).toBe(false);
    delete event.payload.info.total_token_usage;
    const uncertain = parseCodexChunk(header + codexLine(event) + tokenCount(690000, 2816, 2));
    expect(uncertain.events?.map(row => row.requestOrdinal)).toEqual([undefined, undefined]);
  });

  it('does not treat empty or invalid cumulative metadata as a request identity', () => {
    for (const total of [{}, { unrelated: 1 }, { input_tokens: -1 }, { input_tokens: 'bad' }]) {
      const event = JSON.parse(tokenCount(1000, 600, 40));
      event.payload.info.total_token_usage = total;
      const parsed = parseCodexChunk(turnCtx + codexLine(event) + codexLine(event));
      expect(parsed.perModel.get('gpt-5.5')?.turns).toBe(2);
      expect(parsed.events?.map((e) => e.sourceId)[0]).not.toBe(parsed.events?.map((e) => e.sourceId)[1]);
    }
  });

  it('distinguishes an absent write count from a provider-reported zero', () => {
    const missing = JSON.parse(tokenCount(1000, 600, 40));
    delete missing.payload.info.last_token_usage.cache_write_input_tokens;
    expect(parseCodexChunk(codexLine(missing)).events?.[0].usage.cacheCreationUnreported).toBe(true);
    expect(parseCodexChunk(tokenCount(1000, 600, 40)).events?.[0].usage.cacheCreationUnreported).toBeUndefined();
  });

  it('ignores changing non-token metadata in a repeated cumulative notification', () => {
    const event = JSON.parse(tokenCount(1000, 600, 40));
    const first = parseCodexChunk(turnCtx + codexLine(event));
    event.payload.info.total_token_usage.received_at = 123;
    expect(parseCodexChunk(codexLine(event), first.parserState).events).toEqual([]);
  });

  it('incomplete trailing line is not consumed', () => {
    const { consumedBytes } = parseCodexChunk('{"type":"event_msg"'); // no newline
    expect(consumedBytes).toBe(0);
  });
});

describe('parseOmpChunk (P-015)', () => {
  const msg = (id: string, usage: Record<string, number>, model = 'claude-opus-4-8') =>
    JSON.stringify({
      type: 'message',
      id,
      timestamp: '2026-05-09T04:16:15.309Z',
      message: { role: 'assistant', provider: 'anthropic', model, usage },
    }) + '\n';

  it('sums assistant message usage per model, deduped by line id (max-merge)', () => {
    const chunk =
      msg('a1', { input: 1313, output: 52, cacheRead: 29440, cacheWrite: 100 }) +
      msg('a1', { input: 1313, output: 60, cacheRead: 29440, cacheWrite: 100 }) + // same id, grown output
      msg('a2', { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 }, 'gpt-5.5');
    const { perModel } = parseOmpChunk(chunk);
    const opus = perModel.get('claude-opus-4-8')!;
    expect(opus.turns).toBe(1);
    expect(opus.inputTokens).toBe(1313);
    expect(opus.outputTokens).toBe(60); // max-merged
    expect(opus.cacheReadTokens).toBe(29440);
    expect(opus.cacheCreationTokens).toBe(100);
    expect(perModel.get('gpt-5.5')!.turns).toBe(1);
  });

  it('ignores user messages and assistant messages without usage', () => {
    const user = JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', model: 'x' } }) + '\n';
    const noUsage = JSON.stringify({ type: 'message', id: 'a9', message: { role: 'assistant', model: 'x' } }) + '\n';
    expect(parseOmpChunk(user + noUsage).perModel.size).toBe(0);
  });
});

describe('providerForModel / defaultAdapters', () => {
  it('routes gpt/codex models to openai, claude models to anthropic', () => {
    expect(providerForModel('gpt-5.5')).toBe('openai');
    expect(providerForModel('claude-opus-4-8')).toBe('anthropic');
    expect(providerForModel('o3-mini')).toBe('openai');
  });

  it('default adapter set covers claude + codex + omp roots', () => {
    const names = defaultAdapters().map((a) => a.name);
    expect(names).toEqual(['claude', 'codex', 'omp']);
    for (const a of defaultAdapters()) expect(a.root).toMatch(/\/\.(claude|codex|omp)\//);
  });
});

describe('codex session identity + per-session isolation roots (WI-2140701 (a))', () => {
  it('codexSessionIdForFile: rollout-<ts>-<uuid>.jsonl → the bare uuid (= adv_sessions.session_id)', () => {
    expect(
      codexSessionIdForFile(
        '/home/x/.papercusp/su-codex-homes/session-21396/sessions/2026/09/02/rollout-2026-09-02T01-10-49-01a06086-e882-7e10-9079-aa29e6a00097.jsonl',
      ),
    ).toBe('01a06086-e882-7e10-9079-aa29e6a00097');
  });

  it('codexSessionIdForFile: a non-rollout name falls back to the basename (the pre-fix behaviour)', () => {
    expect(codexSessionIdForFile('/tmp/whatever/abc-123.jsonl')).toBe('abc-123');
  });

  it('only the default codex adapter carries the rollout extractor; claude/omp keep the basename default', () => {
    const byName = new Map(defaultAdapters().map((a) => [a.name, a]));
    expect(byName.get('codex')?.sessionIdForFile).toBe(codexSessionIdForFile);
    expect(byName.get('claude')?.sessionIdForFile).toBeUndefined();
    expect(byName.get('omp')?.sessionIdForFile).toBeUndefined();
  });

  it('parseCodexChunk captures cache_write_input_tokens as cacheCreationTokens', () => {
    const chunk = codexLine({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 250, output_tokens: 40 },
        },
      },
    });
    const d = parseCodexChunk(chunk).perModel.get(UNKNOWN_CODEX_MODEL)!;
    expect(d).toMatchObject({ turns: 1, inputTokens: 150, cacheReadTokens: 600, cacheCreationTokens: 250, outputTokens: 40 });
    expect(d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens).toBe(1000);
  });

  it('codexSessionRoots: one root per <base>/<home>/sessions; homes without one and stray files are skipped; missing base → []', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-homes-'));
    try {
      await fs.mkdir(path.join(base, 'session-1', 'sessions', '2026', '09', '02'), { recursive: true });
      await fs.mkdir(path.join(base, 'session-2', 'config-only'), { recursive: true });
      await fs.writeFile(path.join(base, 'stray.txt'), 'x');
      expect(await codexSessionRoots(base)).toEqual([path.join(base, 'session-1', 'sessions')]);
      expect(await codexSessionRoots(path.join(base, 'does-not-exist'))).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  // WI-2144763 / migration 1120. The value this lifts is adv_sessions.id (the PK),
  // which is what lets the INSERT stamp harness_slug for a psu codex session
  // without a join. Codex was ~92% of the post-1119 attribution gap because its
  // adapter carried no such key and fell through to the session route, which
  // cannot find these rows at all (their session_id is the rollout uuid).
  describe('advSessionIdFromCodexHome', () => {
    it('lifts adv_sessions.id from a <base>/session-<advId>/sessions root', () => {
      expect(advSessionIdFromCodexHome(path.join('/b', 'session-12441', 'sessions'))).toBe(12441);
      // Pairs with codexSessionRoots above: whatever that returns must be parseable.
      expect(advSessionIdFromCodexHome(path.join('/tmp/codex-homes-x', 'session-1', 'sessions'))).toBe(1);
    });

    it('returns undefined — never NaN — for a root that carries no adv id', () => {
      // Each of these would bind NaN into the INSERT if this parsed loosely, and a
      // NaN bind is far worse than the NULL that degrades to the session fallback.
      for (const root of [
        path.join('/b', 'notsession-1', 'sessions'), // wrong prefix
        path.join('/b', 'session-abc', 'sessions'), // non-numeric id
        path.join('/b', 'session-', 'sessions'), // empty id
        path.join('/b', 'session-12x4', 'sessions'), // partially numeric
        path.join('/home/u', '.claude', 'projects'), // a claude root, not codex
      ]) {
        expect(advSessionIdFromCodexHome(root)).toBeUndefined();
      }
    });

    it('rejects a non-positive or unsafe id rather than binding it', () => {
      expect(advSessionIdFromCodexHome(path.join('/b', 'session-0', 'sessions'))).toBeUndefined();
      expect(
        advSessionIdFromCodexHome(path.join('/b', `session-${'9'.repeat(25)}`, 'sessions')),
      ).toBeUndefined();
    });
  });
});
