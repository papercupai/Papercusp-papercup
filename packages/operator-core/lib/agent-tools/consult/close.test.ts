import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAgentIdentity: vi.fn(),
  getOrgPg: vi.fn(),
  consultCloseCore: vi.fn(),
  withConversationsIdentityScope: vi.fn(),
  conversationsScopeWorkspace: vi.fn(),
  postReply: vi.fn(),
  settleConsultConversation: vi.fn(),
  consultExpiryStopAnsweringSession: vi.fn(),
  listLiveTasks: vi.fn(),
  killTask: vi.fn(),
  stopAnsweringSession: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.resolveAgentIdentity }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: mocks.getOrgPg,
}));
vi.mock('../../consult/consult-verbs-core', () => ({ consultCloseCore: mocks.consultCloseCore }));
vi.mock('../coordination/conversations', () => ({
  withConversationsIdentityScope: mocks.withConversationsIdentityScope,
  conversationsScopeWorkspace: mocks.conversationsScopeWorkspace,
  postReply: mocks.postReply,
  settleConsultConversation: mocks.settleConsultConversation,
}));
vi.mock('../../consult/consult-expiry-adapters', () => ({
  consultExpiryStopAnsweringSession: mocks.consultExpiryStopAnsweringSession,
}));
vi.mock('../../task-manager/store', () => ({ listLiveTasks: mocks.listLiveTasks }));
vi.mock('../../task-manager/control', () => ({ killTask: mocks.killTask }));

import consultCloseTool from './close';

type CloseToolWithHandler = {
  handler: (args: unknown, ctx: unknown) => Promise<unknown>;
};

describe('consult:close production task-stopper binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'reviewer-1' });
    mocks.getOrgPg.mockReturnValue({ sql: vi.fn() });
    mocks.withConversationsIdentityScope.mockImplementation((_identity, _scope, run) => run());
    mocks.conversationsScopeWorkspace.mockReturnValue('ws-1');
    mocks.consultExpiryStopAnsweringSession.mockReturnValue(mocks.stopAnsweringSession);
    mocks.consultCloseCore.mockImplementation(async (_request, deps) => {
      await deps.stopAnsweringSession?.({
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        answeringOwnerId: 'reviewer-2-fork',
        sourceOwnerId: 'reviewer-2',
      });
      return { ok: true, post_id: 42, state: 'closed_answered' };
    });
  });

  it('binds the conversation-scoped task stopper so a prior responder close can stop the next answerer', async () => {
    const result = await (consultCloseTool as unknown as CloseToolWithHandler).handler({
      conversation_id: 'conv-1',
      outcome: 'answered',
      answer: 'The consult is settled.',
    }, {});

    expect(mocks.consultExpiryStopAnsweringSession).toHaveBeenCalledWith({
      listLiveTasks: expect.any(Function),
      killTask: expect.any(Function),
    });
    expect(mocks.consultCloseCore).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        authorId: 'reviewer-1',
        conversationId: 'conv-1',
        outcome: 'answered',
      }),
      expect.objectContaining({ stopAnsweringSession: mocks.stopAnsweringSession }),
    );
    expect(mocks.stopAnsweringSession).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      answeringOwnerId: 'reviewer-2-fork',
      sourceOwnerId: 'reviewer-2',
    });
    expect(result).toEqual({ data: { ok: true, post_id: 42, state: 'closed_answered' } });
  });
});
