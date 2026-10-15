import { describe, expect, it } from 'vitest';
import type { RouteContext } from '../../define-route';
import routes, { deleteExternalTurnsRoute, externalTurnRoute } from './external-turns';

const context = { params: { slug: 'portal', chatId: 'chat-1' } } as unknown as RouteContext;
const request = (body: unknown) => new Request('http://localhost/api/harness/portal/agent-chats/chat-1/external-turns', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('agent-chat external-turn route', () => {
  it('is loopback-only and does not share the messages route', () => {
    expect(externalTurnRoute).toMatchObject({
      method: 'POST', path: '/harness/:slug/agent-chats/:chatId/external-turns', auth: 'loopback',
    });
  });

  it('rejects browser-shaped or untrusted input before the writer', async () => {
    const response = await externalTurnRoute.handler(request({ role: 'user', content: 'hi' }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'source must be phone-livekit' });
  });
});

describe('agent-chat external-turn deletion route (WI-10006406)', () => {
  const del = (body: unknown) => new Request('http://localhost/api/harness/portal/agent-chats/chat-1/external-turns', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('is the loopback-only DELETE twin of the append route and is registered', () => {
    expect(deleteExternalTurnsRoute).toMatchObject({
      method: 'DELETE', path: '/harness/:slug/agent-chats/:chatId/external-turns', auth: 'loopback',
    });
    expect(routes).toContain(deleteExternalTurnsRoute);
  });

  it('refuses other sources and a missing room before taking the chat lock', async () => {
    const wrongSource = await deleteExternalTurnsRoute.handler(del({ source: 'browser', roomName: 'r' }), context);
    expect(wrongSource.status).toBe(400);
    expect(await wrongSource.json()).toEqual({ error: 'source must be phone-livekit' });
    const noRoom = await deleteExternalTurnsRoute.handler(del({ source: 'phone-livekit' }), context);
    expect(noRoom.status).toBe(400);
    expect(await noRoom.json()).toEqual({ error: 'roomName is required' });
  });
});
