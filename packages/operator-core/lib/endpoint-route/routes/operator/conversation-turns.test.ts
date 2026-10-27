/**
 * conversation-turns route — the `active` id alias (WI-4838 /
 * multi-window-chat-coherence P-001). A window whose sync-delivered
 * conversation id hasn't resolved posts to the literal `active`; the route
 * resolves the ACTIVE conversation server-side (per the request's workspace
 * scope), appends, and returns the resolved `conversationId` so the client
 * adopts it. This is the seam that makes "silently skip the persist" a
 * non-path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../operator-conversations', () => ({
  OperatorTurnIdentityConflict: class extends Error {},
  getOrCreateActiveConversation: vi.fn(),
  getConversationById: vi.fn(),
  appendTurn: vi.fn(),
  listTurnsRecent: vi.fn(),
}));
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

import routes from './conversation-turns';
import {
  getOrCreateActiveConversation,
  getConversationById,
  appendTurn,
  listTurnsRecent,
  OperatorTurnIdentityConflict,
} from '../../../operator-conversations';
import { notifySyncInvalidate } from '../../../sync-sse';

const getConv = vi.mocked(getOrCreateActiveConversation);
const getExplicitConv = vi.mocked(getConversationById);
const append = vi.mocked(appendTurn);
const listRecent = vi.mocked(listTurnsRecent);
const invalidate = vi.mocked(notifySyncInvalidate);

type RouteTool = {
  method: string;
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};
const [get, post] = routes as unknown as RouteTool[];

beforeEach(() => {
  vi.clearAllMocks();
  getConv.mockResolvedValue({ id: 'conv-real-uuid' } as never);
  getExplicitConv.mockImplementation(async (id) => ({ id } as never));
  append.mockResolvedValue({ id: 't1', seq: 5 } as never);
  listRecent.mockResolvedValue({ turns: [], hasMoreEarlier: false } as never);
});

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/operator/conversations/active/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /operator/conversations/:id/turns', () => {
  it('P010 forwards a stable turn identity and refuses malformed identities before writing', async () => {
    const turnId = '2df6bb78-575f-4989-8257-d2c973fa7477';
    expect((await post.handler(postReq({ role: 'assistant', text: 'reply', turnId }), {
      params: { id: 'conv-explicit' },
    })).status).toBe(200);
    expect(append.mock.calls[0][0]).toMatchObject({ turnId, conversationId: 'conv-explicit' });
    append.mockClear();
    expect((await post.handler(postReq({ role: 'assistant', text: 'reply', turnId: 'invalid' }), {
      params: { id: 'conv-explicit' },
    })).status).toBe(400);
    expect(append).not.toHaveBeenCalled();
  });

  it('P010 refuses a competing identity payload without acknowledging a turn', async () => {
    append.mockRejectedValueOnce(new OperatorTurnIdentityConflict());
    const response = await post.handler(postReq({ role: 'assistant', text: 'changed',
      turnId: '2df6bb78-575f-4989-8257-d2c973fa7477' }), { params: { id: 'conv-explicit' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'turn identity conflict' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("resolves the literal 'active' server-side and returns the real conversationId", async () => {
    const res = await post.handler(postReq({ role: 'user', text: 'hi', source: 'voice_stt' }), {
      params: { id: 'active' },
    });
    const j = (await res.json()) as { conversationId?: string };
    expect(getConv).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-real-uuid',
      role: 'user',
      text: 'hi',
      source: 'voice_stt',
    });
    expect(j.conversationId).toBe('conv-real-uuid');
    expect(invalidate).toHaveBeenCalledWith('operatorTurns.page', {
      conversationId: 'conv-real-uuid',
    });
  });

  it('validates a concrete id in the active workspace before appending', async () => {
    const res = await post.handler(postReq({ role: 'assistant', text: 'yo' }), {
      params: { id: 'conv-explicit' },
    });
    const j = (await res.json()) as { conversationId?: string };
    expect(getConv).not.toHaveBeenCalled();
    expect(getExplicitConv).toHaveBeenCalledWith('conv-explicit');
    expect(append.mock.calls[0][0]).toMatchObject({ conversationId: 'conv-explicit' });
    expect(j.conversationId).toBe('conv-explicit');
  });

  it('fails closed when a concrete id is outside the active workspace', async () => {
    getExplicitConv.mockResolvedValueOnce(null);
    const res = await post.handler(postReq({ role: 'user', text: 'do not write' }), {
      params: { id: 'foreign-conversation' },
    });
    expect(res.status).toBe(404);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('GET /operator/conversations/:id/turns', () => {
  it("resolves 'active' for reads too", async () => {
    await get.handler(
      new Request('http://127.0.0.1/api/operator/conversations/active/turns?limit=30'),
      { params: { id: 'active' } },
    );
    expect(getConv).toHaveBeenCalledTimes(1);
    expect(listRecent.mock.calls[0][0]).toMatchObject({ conversationId: 'conv-real-uuid' });
  });
});
