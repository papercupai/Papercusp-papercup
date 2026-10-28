/**
 * Plan pui-chat-first-ux-2026-09-28 P-029 (D-029 / D-031): each engine's native
 * usage and todo/plan records become the engine-neutral descriptor fields. The
 * record shapes below are the ones the installed engines write; a field the
 * engine did not measure must stay absent, never guessed.
 */
import { describe, expect, it } from 'vitest';
import {
  claudeAssistantUsage,
  claudeResultUsage,
  claudeTodoPlan,
  codexPlan,
  codexAppServerTokenUsage,
  codexPlanCall,
  codexTokenUsage,
  ompMessageUsage,
  nativeToolArguments,
} from './su-session-usage';

describe('native exact argument snapshots', () => {
  it('retains empty objects and freezes independent nested JSON values', () => {
    expect(nativeToolArguments({})).toEqual({});
    const input = { nested: [{ key: 'original' }], nullable: null };
    const copy = nativeToolArguments(input)!;
    input.nested[0]!.key = 'changed';
    expect(copy).toEqual({ nested: [{ key: 'original' }], nullable: null });
    expect(Object.isFrozen((copy.nested as object[])[0])).toBe(true);
  });
  it.each([undefined, null, [], 'text', { value: undefined }, { value: NaN },
    { value: Infinity }, { value: 1n }, { value: () => {} }, { value: Symbol('x') },
    { value: 'x'.repeat(256_001) }])('refuses absent or inexact JSON arguments', input => {
    expect(nativeToolArguments(input)).toBeNull();
  });
  it('refuses cycles and excessive nesting', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(nativeToolArguments(cycle)).toBeNull();
    let nested: unknown = {}; for (let i = 0; i < 66; i++) nested = { nested };
    expect(nativeToolArguments(nested)).toBeNull();
  });
});

describe('Claude usage', () => {
  it('sums a root assistant message into the context it filled', () => {
    expect(claudeAssistantUsage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 90 } },
    })).toEqual({ contextTokens: 9600, inputTokens: 10, outputTokens: 90 });
  });

  it('ignores sub-agent records, other record types, and records without usage', () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    expect(claudeAssistantUsage({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { usage } })).toBeNull();
    expect(claudeAssistantUsage({ type: 'assistant', isSidechain: true, message: { usage } })).toBeNull();
    expect(claudeAssistantUsage({ type: 'user', message: { usage } })).toBeNull();
    expect(claudeAssistantUsage({ type: 'assistant', message: {} })).toBeNull();
    expect(claudeAssistantUsage({ type: 'assistant', message: { usage: { cache_read_input_tokens: 5 } } })).toBeNull();
    expect(claudeAssistantUsage(null)).toBeNull();
  });

  it('reads the running cost and the context window of the model asked for', () => {
    expect(claudeResultUsage({
      type: 'result',
      total_cost_usd: 0.42,
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 100_000 }, 'claude-opus-4-1': { contextWindow: 200_000 } },
    }, 'claude-haiku-4-5')).toEqual({ costUsd: 0.42, contextWindow: 100_000 });
  });

  it('falls back to the largest window when the model is an alias the SDK did not key by', () => {
    expect(claudeResultUsage({
      type: 'result',
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 100_000 }, 'claude-opus-4-1': { contextWindow: 1_000_000 } },
    }, 'opus')).toEqual({ contextWindow: 1_000_000 });
  });

  it('reports nothing for a result that measured nothing', () => {
    expect(claudeResultUsage({ type: 'result' })).toBeNull();
    expect(claudeResultUsage({ type: 'result', total_cost_usd: -1, modelUsage: {} })).toBeNull();
    expect(claudeResultUsage({ type: 'assistant', total_cost_usd: 1 })).toBeNull();
  });

  it('turns a TodoWrite call into the plan list and drops malformed entries', () => {
    expect(claudeTodoPlan('TodoWrite', {
      todos: [
        { content: ' Read the file ', status: 'completed', activeForm: 'Reading' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
        { content: '', status: 'pending' },
        { content: 'Unknown status', status: 'blocked' },
        'not an object',
      ],
    })).toEqual([
      { text: 'Read the file', status: 'completed' },
      { text: 'Write the fix', status: 'in_progress' },
      { text: 'Run tests', status: 'pending' },
    ]);
    expect(claudeTodoPlan('Edit', { todos: [] })).toBeNull();
    expect(claudeTodoPlan('TodoWrite', { todos: 'none' })).toBeNull();
    expect(claudeTodoPlan('TodoWrite', { todos: [] })).toEqual([]);
  });
});

describe('Codex usage', () => {
  it('reads the latest call and the model window from a rollout token_count', () => {
    expect(codexTokenUsage({
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 90_000, output_tokens: 4000, total_tokens: 94_000 },
        last_token_usage: { input_tokens: 30_000, output_tokens: 800, total_tokens: 30_800 },
        model_context_window: 272_000,
      },
      rate_limits: null,
    })).toEqual({ contextTokens: 30_800, contextWindow: 272_000, inputTokens: 30_000, outputTokens: 800 });
  });

  it('reports nothing before the first model call (info is null) or for another event', () => {
    expect(codexTokenUsage({ type: 'token_count', info: null })).toBeNull();
    expect(codexTokenUsage({ type: 'task_started', info: { model_context_window: 1 } })).toBeNull();
  });

  // WI-10006653: the frame a live app-server turn sends. Shape captured from
  // codex-cli 0.160.1 on 2026-10-06 (numbers from that capture).
  it('reads the same context figure from a live app-server thread/tokenUsage/updated', () => {
    const breakdown = { totalTokens: 22_433, inputTokens: 22_428, cachedInputTokens: 12_288, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
    expect(codexAppServerTokenUsage({
      threadId: 't', turnId: 'u',
      tokenUsage: { total: { ...breakdown, totalTokens: 90_000 }, last: breakdown, modelContextWindow: 258_400 },
    })).toEqual({ contextTokens: 22_433, contextWindow: 258_400, inputTokens: 22_428, outputTokens: 5 });
  });

  it('reports nothing for an app-server frame without measured usage', () => {
    expect(codexAppServerTokenUsage({ threadId: 't' })).toBeNull();
    expect(codexAppServerTokenUsage({ tokenUsage: { last: {}, total: {}, modelContextWindow: null } })).toBeNull();
    expect(codexAppServerTokenUsage(null)).toBeNull();
  });

  it('parses an update_plan function call whose arguments are a JSON string', () => {
    expect(codexPlanCall({
      type: 'function_call',
      name: 'update_plan',
      call_id: 'call_1',
      arguments: JSON.stringify({
        explanation: 'start',
        plan: [
          { step: 'Inspect calc.js', status: 'completed' },
          { step: 'Add the test', status: 'in_progress' },
          { step: 'Ship', status: 'pending' },
        ],
      }),
    })).toEqual([
      { text: 'Inspect calc.js', status: 'completed' },
      { text: 'Add the test', status: 'in_progress' },
      { text: 'Ship', status: 'pending' },
    ]);
  });

  it('rejects other calls and unparseable arguments', () => {
    expect(codexPlanCall({ type: 'function_call', name: 'shell', arguments: '{}' })).toBeNull();
    expect(codexPlanCall({ type: 'function_call', name: 'update_plan', arguments: '{not json' })).toBeNull();
    expect(codexPlanCall({ type: 'message', name: 'update_plan', arguments: '{"plan":[]}' })).toBeNull();
  });

  it('accepts the app-server camelCase status and an already-parsed object', () => {
    expect(codexPlan({ plan: [{ step: 'Go', status: 'inProgress' }, { step: 'x', status: 'later' }] }))
      .toEqual([{ text: 'Go', status: 'in_progress' }]);
    expect(codexPlan({ explanation: 'no plan' })).toBeNull();
  });
});

describe('OMP usage', () => {
  it('reads an assistant message total and its cost', () => {
    expect(ompMessageUsage({
      role: 'assistant',
      usage: { input: 2000, output: 300, cacheRead: 7000, cacheWrite: 0, totalTokens: 9300, cost: { total: 0.012 } },
    })).toEqual({ usage: { contextTokens: 9300, inputTokens: 2000, outputTokens: 300 }, cost: 0.012 });
  });

  it('sums the parts when totalTokens is missing, and leaves cost absent when unpriced', () => {
    expect(ompMessageUsage({ role: 'assistant', usage: { input: 10, output: 5, cacheRead: 100 } }))
      .toEqual({ usage: { contextTokens: 115, inputTokens: 10, outputTokens: 5 }, cost: undefined });
  });

  it('ignores user and tool messages and messages without usage', () => {
    expect(ompMessageUsage({ role: 'user', usage: { input: 1, output: 1 } })).toBeNull();
    expect(ompMessageUsage({ role: 'toolResult', usage: { input: 1, output: 1 } })).toBeNull();
    expect(ompMessageUsage({ role: 'assistant' })).toBeNull();
    expect(ompMessageUsage({ role: 'assistant', usage: {} })).toBeNull();
  });
});
