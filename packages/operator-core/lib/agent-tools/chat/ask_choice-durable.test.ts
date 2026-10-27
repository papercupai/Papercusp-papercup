import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardSpec, UnifiedToolContext } from '@papercusp/agent-mcp';

const h = vi.hoisted(() => ({
  create: vi.fn(), before: vi.fn(), commit: vi.fn(), listen: vi.fn(), refresh: vi.fn(), stop: vi.fn(),
  sign: vi.fn(), open: vi.fn(), flag: vi.fn(),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../operator/converse-card', () => ({ createConverseCard: h.create }));
vi.mock('../operator/converse-chat-binding', () => ({ mintConverseCardBinding: h.sign }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ kind: 'human', id: 'owner' }) }));
vi.mock('../coordination/escalations', () => ({ openEscalation: h.open, resolveEscalation: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.flag, onFlagChange: vi.fn() }));
import { FLAGS } from '@papercusp/flags';
import askChoice from './ask_choice';

const parent = { workspaceId: 'ws-a', conversationId: 'conversation-a', turnId: 'turn-a', runId: 'parent-a',
  credentialSha256: 'b'.repeat(64), authority: { kind: 'system' as const, principalId: 'system:operator', credentialSha256: 'a'.repeat(64) } };
const args = { question: 'Choose', options: [{ id: 'YES', label: 'Proceed' }] };
const info = { correlationId: 'card-a', workspaceId: 'ws-a', runId: 'child-a' };
const picks = { action: 'submit', payload: { picks: ['yes'] } };
type Spec = CardSpec;
const handler = (askChoice as unknown as { handler(input: typeof args, ctx: UnifiedToolContext): Promise<{ content: Array<{ text: string }> }> }).handler;
const ctx = (askUser: unknown) => ({ workspaceId: 'ws-a', runId: 'child-a', dispatchCallId: 'dispatch-a',
  chatParent: parent, signal: new AbortController().signal, log: vi.fn(), askUser } as unknown as UnifiedToolContext);

beforeEach(() => {
  vi.clearAllMocks();
  h.flag.mockResolvedValue(false); h.sign.mockResolvedValue('signed-native-receipt'); h.open.mockResolvedValue(null);
  h.before.mockResolvedValue(undefined); h.commit.mockImplementation(async response => ({ accepted: true, response }));
  h.refresh.mockResolvedValue(undefined);
  h.listen.mockResolvedValue({ refresh: h.refresh, stop: h.stop });
  h.create.mockReturnValue({ hooks: () => ({ beforeCard: h.before, commitResponse: h.commit }), listen: h.listen });
});

describe('P010 actual ask_choice durable hooks', () => {
  it.each(['submit', 'decline', 'cancel'])('prepares before publication, closes notification gaps, and signs the actual %s result', async action => {
    const askUser = vi.fn(async (spec: Spec) => {
      expect(spec.beforeCard).toBeTypeOf('function');
      expect(spec.commitResponse).toBe(h.commit);
      await spec.beforeCard!(info, new AbortController().signal);
      expect(h.before).toHaveBeenCalledOnce(); expect(h.listen).toHaveBeenCalledOnce();
      spec.onCard!(info);
      return action === 'submit' ? picks : { action };
    });
    const result = await handler(args, ctx(askUser));
    const value = JSON.parse(result.content[0].text);
    expect(value.converseCardBinding).toBe('signed-native-receipt');
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ parent,
      binding: { dispatchCallId: 'dispatch-a', childRunId: 'child-a', credentialSha256: parent.credentialSha256 },
      tool: { name: 'chat:ask_choice', callId: 'dispatch-a', input: { ...args, options: [{ id: 'yes', label: 'Proceed' }] } } }));
    expect(h.sign).toHaveBeenCalledWith({ parent, dispatchCallId: 'dispatch-a', childRunId: 'child-a', correlationId: 'card-a' });
    expect(h.refresh).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
    expect(h.open).not.toHaveBeenCalled();
    if (action === 'submit') expect(value.picks).toEqual([{ option_id: 'yes', label: 'Proceed' }]);
  });

  it('waits for durable preparation and refuses a failed write without returning success', async () => {
    h.before.mockRejectedValue(new Error('commit-ack-lost'));
    const publish = vi.fn();
    const askUser = async (spec: Spec) => { await spec.beforeCard!(info, new AbortController().signal); publish(); return picks; };
    await expect(handler(args, ctx(askUser))).rejects.toThrow('commit-ack-lost');
    expect(publish).not.toHaveBeenCalled(); expect(h.listen).not.toHaveBeenCalled();
  });

  it('does not prepare or publish if signing fails, and closes listeners on failed decisions', async () => {
    const askUser = async (spec: Spec) => { await spec.beforeCard!(info, new AbortController().signal); throw new Error('decision-ack-lost'); };
    h.sign.mockRejectedValueOnce(new Error('signer-unavailable'));
    await expect(handler(args, ctx(askUser))).rejects.toThrow('signer-unavailable');
    expect(h.before).not.toHaveBeenCalled();
    await expect(handler(args, ctx(askUser))).rejects.toThrow('decision-ack-lost');
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it('stamps version and conversation on the inbox link so its existing authority guard runs', async () => {
    h.flag.mockImplementation(async flag => flag === FLAGS.INBOX_DURABLE_ESCALATIONS);
    const askUser = async (spec: Spec) => { await spec.beforeCard!(info, new AbortController().signal); spec.onCard!(info); return picks; };
    await handler(args, ctx(askUser));
    expect(h.open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ meta: {
      cardCorrelationId: 'card-a', cardWorkspaceId: 'ws-a', cardProtocolVersion: 1, cardConversationId: 'conversation-a',
    } }));
  });

  it('retains the legacy path outside a signed converse mount and refuses incomplete signed context', async () => {
    const legacy = ctx(async (spec: Spec) => { expect(spec.beforeCard).toBeUndefined(); return picks; });
    delete legacy.chatParent;
    const result = await handler(args, legacy);
    expect(JSON.parse(result.content[0].text).converseCardBinding).toBeUndefined();
    expect(h.create).not.toHaveBeenCalled();
    await expect(handler(args, { ...ctx(vi.fn()), dispatchCallId: undefined })).rejects.toThrow('invalid-card-binding');
    await expect(handler(args, { ...ctx(vi.fn()), workspaceId: 'foreign' })).rejects.toThrow('invalid-card-binding');
  });
});
