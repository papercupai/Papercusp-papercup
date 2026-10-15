import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openConversation: vi.fn(),
}));

vi.mock('../identity', () => ({
  ADMIN_COORD_UI_OWNER: 'pc-admin-coord-ui',
  resolveAgentIdentity: (ctx: { uiClientId?: string }) => ({
    ownerId: ctx.uiClientId ?? 'asker-1',
    ownerLabel: ctx.uiClientId ?? 'Asker 1',
  }),
}));
vi.mock('../conversations', () => ({ openConversation: h.openConversation }));

import tool from './ask';

const handle = {
  event_keys: ['conversation:answered:conv-1'],
  await_ids: [41],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [41] } },
  handle_note: 'captured requester wake handle',
};

const call = async (ctx: Record<string, unknown> = {
  transport: 'http',
  uiClientId: 'pc-admin-coord-ui',
}) => {
  const out = await (tool as any).handler(
    { question: 'Which invariant applies?', to: ['peer-1'] },
    ctx,
  );
  return JSON.parse(out.content[0].text);
};

beforeEach(() => {
  h.openConversation.mockReset().mockResolvedValue({
    conversation: { id: 'conv-1', scope: 'question:conv-1' },
    topics: [],
    direct_to: ['peer-1'],
    unrouted: false,
    delivered: 1,
    interestWatch: handle,
  });
});

describe('coord:ask requester interest handle (P-024)', () => {
  it('is hidden from every agent role and rejects direct agent/MCP invocation', async () => {
    expect(tool.agentRoles).toEqual([]);
    expect(tool.description).toMatch(/^OWNER-UI ONLY\./);
    expect(tool.description).toMatch(/Agent sessions are denied/);
    await expect(call({ transport: 'mcp', uiClientId: 'pc-admin-coord-ui' }))
      .rejects.toThrow(/owner-UI-only/);
    await expect(call({ transport: 'http', uiClientId: 'su-agent' }))
      .rejects.toThrow(/owner-UI-only/);
    expect(h.openConversation).not.toHaveBeenCalled();
  });

  it('projects the question lifecycle cancel handle returned by openConversation', async () => {
    const out = await call();
    expect(out).toMatchObject({
      ok: true,
      conversation_id: 'conv-1',
      asked: ['peer-1'],
      interest_watch: handle,
    });
    expect(h.openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'pc-admin-coord-ui' }),
      expect.objectContaining({ kind: 'question', direct_to: ['peer-1'] }),
    );
  });
});
