import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  selectHistoryWithinBudget,
  DEFAULT_MAX_TURN_CHARS,
} from './operator-converse-history';

const msg = (role: string, content: string) => ({ role, content });
const tokensFor = (content: string) => Math.ceil(content.length / 4) + 8; // matches PER_TURN_OVERHEAD

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ~1 token per 4 chars (ceiling)', () => {
    expect(estimateTokens('aaaa')).toBe(1);
    expect(estimateTokens('aaaaa')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('handles null/undefined as 0', () => {
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });
});

describe('selectHistoryWithinBudget', () => {
  it('returns [] when budget <= 0', () => {
    expect(selectHistoryWithinBudget([msg('user', 'hi')], 0)).toEqual([]);
    expect(selectHistoryWithinBudget([msg('user', 'hi')], -1)).toEqual([]);
  });

  it('returns [] when messages empty / nullish', () => {
    expect(selectHistoryWithinBudget([], 100)).toEqual([]);
    expect(selectHistoryWithinBudget(null, 100)).toEqual([]);
    expect(selectHistoryWithinBudget(undefined, 100)).toEqual([]);
  });

  it('keeps all messages when total fits in budget', () => {
    const msgs = [
      msg('user', 'hello'),
      msg('assistant', 'hi there'),
      msg('user', 'how are you'),
    ];
    const result = selectHistoryWithinBudget(msgs, 1000);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.content)).toEqual(['hello', 'hi there', 'how are you']);
  });

  it('drops oldest messages when budget exceeded', () => {
    // Each message: 40 chars → 10 tokens + 8 overhead = 18 tokens
    const msgs = Array.from({ length: 5 }, (_, i) =>
      msg('user', `msg${i} ${'x'.repeat(35)}`),
    );
    // Budget of 50 → fits ~2 messages (18+18=36, +18=54 exceeds)
    const result = selectHistoryWithinBudget(msgs, 50);
    expect(result).toHaveLength(2);
    // Should be the last 2 (msg3, msg4) in chronological order
    expect(result[0].content.startsWith('msg3')).toBe(true);
    expect(result[1].content.startsWith('msg4')).toBe(true);
  });

  it('truncates messages over maxTurnChars', () => {
    const long = 'x'.repeat(20000);
    const result = selectHistoryWithinBudget([msg('user', long)], 100000, 8000);
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBe(8000 + 1); // +1 for the … char
    expect(result[0].content.endsWith('…')).toBe(true);
  });

  it('preserves chronological order in output', () => {
    const msgs = [
      msg('user', 'first'),
      msg('assistant', 'second'),
      msg('user', 'third'),
      msg('assistant', 'fourth'),
    ];
    const result = selectHistoryWithinBudget(msgs, 1000);
    expect(result.map((m) => m.content)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('refuses when the most-recent message cannot fit the hard budget', () => {
    const huge = 'x'.repeat(2000); // 500 tokens + 8 overhead = 508 tokens
    expect(() => selectHistoryWithinBudget([msg('user', huge)], 10)).toThrow('history-budget-exceeded');
  });

  it('P010 hard history budget', () => {
    const messages = [msg('assistant', 'older'.repeat(1600)), msg('user', 'latest'.repeat(1300))];
    // The host supplies its real rendered cost, including the existing summary and framing.
    const cost = (selected: ReadonlyArray<ReturnType<typeof msg>>) => Math.ceil(JSON.stringify({
      summary: 's'.repeat(6000), messages: selected,
    }).length / 4);
    const latestOnly = [messages[1]];
    const exact = cost(latestOnly);
    for (const budget of [exact, exact + 1]) {
      const selected = selectHistoryWithinBudget(messages, budget, 8000, cost);
      expect(selected).toEqual(latestOnly);
      expect(cost(selected)).toBeLessThanOrEqual(budget);
    }
    expect(() => selectHistoryWithinBudget(messages, exact - 1, 8000, cost))
      .toThrow('history-budget-exceeded');
    expect(selectHistoryWithinBudget(messages, cost(messages), 8000, cost)).toEqual(messages);
    expect(() => selectHistoryWithinBudget([], 5000, 8000, () => 5001))
      .toThrow('history-budget-exceeded');
    expect(() => selectHistoryWithinBudget(messages, 5000, 8000, () => Number.NaN))
      .toThrow('invalid-history-estimate');
    const long = Array.from({ length: 16384 }, (_, id) => ({ ...msg('user', ''), id }));
    let estimates = 0;
    const bounded = selectHistoryWithinBudget(long, 5000, 8000, selected => {
      estimates++;
      return 1000 + selected.length;
    });
    expect(bounded).toHaveLength(4000);
    expect(bounded[0].id).toBe(12384);
    expect(bounded.at(-1)?.id).toBe(16383);
    expect(estimates).toBeLessThan(100);
  });

  it('respects per-turn overhead in budget accounting', () => {
    // 10 messages of empty content: each = 0+8 = 8 tokens
    const msgs = Array.from({ length: 10 }, () => msg('user', ''));
    // Budget for exactly 3 of them = 24
    const result = selectHistoryWithinBudget(msgs, 24);
    expect(result).toHaveLength(3);
  });

  it('preserves role field correctly', () => {
    const msgs = [msg('system', 'sys'), msg('user', 'u'), msg('assistant', 'a')];
    const result = selectHistoryWithinBudget(msgs, 1000);
    expect(result.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('handles messages with missing content gracefully', () => {
    const msgs = [
      msg('user', 'hello'),
      { role: 'assistant' } as unknown as ReturnType<typeof msg>,
      msg('user', 'world'),
    ];
    const result = selectHistoryWithinBudget(msgs, 1000);
    expect(result).toHaveLength(3);
    expect(result[1].content).toBe('');
  });

  it('default maxTurnChars (8000) applied when not specified', () => {
    const long = 'a'.repeat(DEFAULT_MAX_TURN_CHARS + 5000);
    const result = selectHistoryWithinBudget([msg('user', long)], 100000);
    expect(result[0].content.length).toBe(DEFAULT_MAX_TURN_CHARS + 1); // +1 for …
  });
});
