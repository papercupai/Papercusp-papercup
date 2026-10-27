import type { RpcFrame, SuStdioPeer } from './su-session-stdio-peer';

function record(value: unknown): RpcFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex history record');
  return value as RpcFrame;
}

/** Read the child's native view, which applies every ancestor's inclusive fork
 * boundary. Reading ancestor rollouts directly would leak later parent turns.
 * These are history reads only: no request/card callback or command is restored. */
async function* pages(request: SuStdioPeer['request'], method: string, params: RpcFrame): AsyncGenerator<RpcFrame> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await request({ method, params: { ...params, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) } });
    if (!Array.isArray(page.data)) throw new Error('Codex history page has no records');
    for (const value of page.data) yield record(value);
    if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
      throw new Error('Invalid Codex history cursor');
    }
    cursor = page.nextCursor as string | undefined;
    if (cursor && seen.has(cursor)) throw new Error('Codex history pagination did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
}

export async function* readCodexVisibleHistory(request: SuStdioPeer['request'], threadId: string): AsyncGenerator<{
  turn: RpcFrame; items: AsyncIterable<RpcFrame>;
}> {
  const turns = new Set<string>();
  for await (const turn of pages(request, 'thread/turns/list', { threadId, itemsView: 'notLoaded' })) {
    if (typeof turn.id !== 'string' || !turn.id || turns.has(turn.id)) throw new Error('Invalid or repeated Codex history turn');
    turns.add(turn.id);
    const turnId = turn.id;
    async function* items() {
      const seen = new Set<string>();
      for await (const entry of pages(request, 'thread/items/list', { threadId, turnId })) {
        const item = record(entry.item);
        if (entry.turnId !== turnId || typeof item.id !== 'string' || !item.id || seen.has(item.id)) {
          throw new Error('Invalid or repeated Codex history item');
        }
        seen.add(item.id);
        yield item;
      }
    }
    yield { turn, items: items() };
  }
}
