/**
 * card-link.test.ts — unblockLinkedCard, the inbox⇄live-card bridge.
 *
 * resolveCardResponse (the @papercusp/agent-mcp correlator entry) is mocked, so the
 * link-detection + call-shaping + best-effort-swallow logic is exercised in isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  resolveCardResponse: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../operator-chat-store', () => ({ operatorChatChildAuthority: vi.fn(() => async () => true) }));
vi.mock('../operator/converse-card', () => ({ findConverseCard: vi.fn() }));

import { commitLinkedConverseCard, unblockLinkedCard } from './card-link';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { findConverseCard } from '../operator/converse-card';
import { operatorChatChildAuthority } from '../../operator-chat-store';

const mockResolve = resolveCardResponse as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue({ ok: true });
  vi.mocked(findConverseCard).mockReset();
});

describe('unblockLinkedCard — unlinked records are a no-op', () => {
  it('returns {unblocked:false} and never calls the correlator when there is no cardCorrelationId', () => {
    expect(unblockLinkedCard({}, 'opt-a')).toEqual({ unblocked: false });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('treats a non-string cardCorrelationId as unlinked', () => {
    expect(unblockLinkedCard({ cardCorrelationId: 123 }, 'opt-a')).toEqual({ unblocked: false });
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('unblockLinkedCard — linked records resolve the card', () => {
  it('submits the picked choice and includes expectedWorkspaceId when present', () => {
    const res = unblockLinkedCard({ cardCorrelationId: 'corr-1', cardWorkspaceId: 'ws-9' }, 'opt-b');
    expect(mockResolve).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      action: 'submit',
      payload: { picks: ['opt-b'] },
      expectedWorkspaceId: 'ws-9',
    });
    expect(res).toEqual({ unblocked: true });
  });

  it('omits expectedWorkspaceId when the workspace id is absent', () => {
    unblockLinkedCard({ cardCorrelationId: 'corr-1' }, 'opt-b');
    expect(mockResolve).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      action: 'submit',
      payload: { picks: ['opt-b'] },
    });
  });

  it('omits expectedWorkspaceId when the workspace id is a non-string', () => {
    unblockLinkedCard({ cardCorrelationId: 'corr-1', cardWorkspaceId: 42 }, 'opt-b');
    const arg = mockResolve.mock.calls[0][0];
    expect('expectedWorkspaceId' in arg).toBe(false);
  });

  it('passes through res.ok === false as unblocked:false', () => {
    mockResolve.mockReturnValue({ ok: false });
    expect(unblockLinkedCard({ cardCorrelationId: 'corr-1' }, 'x')).toEqual({ unblocked: false });
  });
});

describe('unblockLinkedCard — best-effort', () => {
  it('swallows a correlator throw (card already resolved / run ended)', () => {
    mockResolve.mockImplementation(() => { throw new Error('card not found'); });
    expect(unblockLinkedCard({ cardCorrelationId: 'corr-1' }, 'x')).toEqual({ unblocked: false });
  });
});

describe('version1 durable inbox decision', () => {
  const record = { cardProtocolVersion: 1, cardCorrelationId: 'card',
    cardWorkspaceId: 'ws', cardConversationId: 'conversation' };
  const ctx = { workspaceId: 'ws', isSuperuser: true,
    admissionRecoveryAuthority: { kind: 'superuser', role: 'operator', credentialSha256: 'a'.repeat(64) },
  } as Parameters<typeof commitLinkedConverseCard>[2];

  it('leaves legacy links on their existing path', async () => {
    await commitLinkedConverseCard({ cardCorrelationId: 'legacy' }, 'yes', ctx);
    expect(findConverseCard).not.toHaveBeenCalled();
  });

  it('refuses malformed, foreign and unauthenticated links before durable lookup', async () => {
    for (const foreign of [{ ...record, cardProtocolVersion: 2 }, { ...record, cardWorkspaceId: 'foreign' },
      { ...record, cardConversationId: null }]) {
      await expect(commitLinkedConverseCard(foreign, 'yes', ctx)).rejects.toThrow('unauthorized');
    }
    await expect(commitLinkedConverseCard(record, 'yes', { ...ctx, admissionRecoveryAuthority: undefined }))
      .rejects.toThrow('unauthorized');
    expect(findConverseCard).not.toHaveBeenCalled();
    expect(unblockLinkedCard(record, 'yes')).toEqual({ unblocked: false });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('awaits the authenticated durable decision and propagates uncertain outcomes', async () => {
    const commitResponse = vi.fn(async () => { throw new Error('needs-reconciliation'); });
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: 'card', runId: 'run', workspaceId: 'ws' }) } as never);
    await expect(commitLinkedConverseCard(record, 'yes', ctx)).rejects.toThrow('needs-reconciliation');
    expect(operatorChatChildAuthority).toHaveBeenCalledWith({ workspaceId: 'ws', credentialSha256: 'a'.repeat(64),
      capability: 'coord:write', toolName: 'coord:resolve' });
    expect(findConverseCard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws',
      conversationId: 'conversation', correlationId: 'card', authorizeAdditional: expect.any(Function) }));
    expect(commitResponse).toHaveBeenCalledWith({ action: 'submit', payload: { picks: ['yes'] } },
      { correlationId: 'card', runId: 'run', workspaceId: 'ws' }, 'response');
  });

  it('permits exact committed-winner reconciliation and refuses a competing choice', async () => {
    const commitResponse = vi.fn(async () => ({ accepted: false,
      response: { action: 'submit', payload: { picks: ['yes'] } } }));
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: 'card', runId: 'run', workspaceId: 'ws' }) } as never);
    await expect(commitLinkedConverseCard(record, 'yes', ctx)).resolves.toBeUndefined();
    await expect(commitLinkedConverseCard(record, 'no', ctx)).rejects.toThrow('already-decided');
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
