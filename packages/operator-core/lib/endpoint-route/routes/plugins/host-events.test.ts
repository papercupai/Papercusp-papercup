import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../events/engine', () => ({ emitSystemEvent: vi.fn() }));

const { default: route } = await import('./host-events');
const { emitPluginEvent, pluginEventSubscriberCount } = await import('../../../events/plugin-event-fanout');

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
const handler = (route as unknown as { handler: Handler }).handler;

const open: AbortController[] = [];
afterEach(() => { while (open.length) open.pop()!.abort(); });

async function connect(query: string) {
  const ac = new AbortController();
  open.push(ac);
  const before = pluginEventSubscriberCount();
  const res = await handler(new Request(`http://127.0.0.1/api/plugins/host/events?${query}`, { signal: ac.signal }), {});
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // Pull the initial heartbeat; that also runs the stream's setup (the subscription).
  const first = await reader.read();
  text += decoder.decode(first.value ?? new Uint8Array());
  for (let i = 0; i < 50 && pluginEventSubscriberCount() <= before; i++) await new Promise((r) => setTimeout(r, 10));
  return {
    res,
    ac,
    async readUntil(needle: string, ms = 1000): Promise<string> {
      const deadline = Date.now() + ms;
      while (!text.includes(needle) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
        ]);
        if (!next || next.done) break;
        text += decoder.decode(next.value);
      }
      return text;
    },
  };
}

describe('GET /api/plugins/host/events (WI-39801)', () => {
  it('refuses a connection without plugin, install and name', async () => {
    const res = await handler(new Request('http://127.0.0.1/api/plugins/host/events?plugin=acme&install=pot-a'), {});
    expect(res.status).toBe(400);
  });

  it('streams a plugin event fired in the subscribed install as an SSE message carrying the JSON payload', async () => {
    const conn = await connect('plugin=acme&install=pot-a&name=acme.ping');
    expect(conn.res.headers.get('content-type')).toContain('text/event-stream');
    emitPluginEvent({ name: 'acme.ping', payload: { n: 1 }, installSlug: 'pot-a' });
    const text = await conn.readUntil('"n":1');
    // `message` is the SSE default event name, so the frame carries no `event:` line;
    // PluginIframe.tsx's `message` handler receives it.
    const frame = text.split('\n\n').find((f) => f.includes('data: {"n":1}'));
    expect(frame).toBeDefined();
    expect(frame).not.toMatch(/^event: (?!message)/m);
  });

  it('does not stream events for another name or another install', async () => {
    const conn = await connect('plugin=acme&install=pot-a&name=acme.ping');
    emitPluginEvent({ name: 'acme.pong', payload: { wrong: 'name' }, installSlug: 'pot-a' });
    emitPluginEvent({ name: 'acme.ping', payload: { wrong: 'install' }, installSlug: 'pot-b' });
    emitPluginEvent({ name: 'acme.ping', payload: { right: true }, installSlug: 'pot-a' });
    const text = await conn.readUntil('"right":true');
    expect(text).toContain('{"right":true}');
    expect(text).not.toContain('wrong');
  });

  it('releases its subscription when the client disconnects', async () => {
    const before = pluginEventSubscriberCount();
    const conn = await connect('plugin=acme&install=pot-a&name=acme.ping');
    expect(pluginEventSubscriberCount()).toBe(before + 1);
    conn.ac.abort();
    for (let i = 0; i < 50 && pluginEventSubscriberCount() > before; i++) await new Promise((r) => setTimeout(r, 10));
    expect(pluginEventSubscriberCount()).toBe(before);
  });
});
