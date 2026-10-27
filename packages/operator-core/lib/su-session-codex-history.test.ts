import { expect, it, vi } from 'vitest';
import { readCodexVisibleHistory } from './su-session-codex-history';
import type { RpcFrame } from './su-session-stdio-peer';

it('replays only the native child view across turn and item pages in chronological order', async () => {
  const request = vi.fn(async (frame: RpcFrame) => {
    const p = frame.params as RpcFrame;
    expect(p.threadId).toBe('child');
    expect(p.sortDirection).toBe('asc');
    if (frame.method === 'thread/turns/list') return p.cursor
      ? { data: [{ id: 'child-turn', status: 'completed' }], nextCursor: null }
      : { data: [{ id: 'inherited-turn', status: 'completed' }], nextCursor: 'next-turn' };
    expect(frame.method).toBe('thread/items/list');
    return { data: [{ turnId: p.turnId, item: { id: `${p.turnId}-${p.cursor ? 'answer' : 'prompt'}`,
      type: p.cursor ? 'agentMessage' : 'userMessage' } }], nextCursor: p.cursor ? null : 'next-item' };
  });
  const found: string[] = [];
  for await (const { items } of readCodexVisibleHistory(request, 'child')) {
    for await (const item of items) found.push(String(item.id));
  }
  expect(found).toEqual(['inherited-turn-prompt', 'inherited-turn-answer', 'child-turn-prompt', 'child-turn-answer']);
  expect(request).toHaveBeenCalledTimes(6);
});

it.each(['turn-cursor', 'item-cursor', 'foreign-turn', 'duplicate-turn', 'duplicate-item', 'missing-page'])(
  'refuses malformed native history (%s) instead of claiming a complete replay', async mode => {
    const request = vi.fn(async (frame: RpcFrame) => {
      if (frame.method === 'thread/turns/list') {
        if (mode === 'missing-page') return {};
        return { data: mode === 'turn-cursor' ? [] : [{ id: 'one', status: 'completed' }],
          nextCursor: ['turn-cursor', 'duplicate-turn'].includes(mode) ? 'repeat' : null };
      }
      return { data: mode === 'item-cursor' ? [] : [{ turnId: mode === 'foreign-turn' ? 'other' : 'one', item: { id: 'item' } }],
        nextCursor: ['item-cursor', 'duplicate-item'].includes(mode) ? 'repeat' : null };
    });
    const read = async () => {
      for await (const { items } of readCodexVisibleHistory(request, 'child')) for await (const _ of items) { /* drain */ }
    };
    await expect(read()).rejects.toThrow(/Codex history/);
    expect(request.mock.calls.length).toBeLessThan(6);
  });
