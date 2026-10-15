import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveExplicitAgentOwnerIdMock = vi.hoisted(() => vi.fn());
const couplingMocks = vi.hoisted(() => ({
  declareCoupling: vi.fn(),
  suppressCoupling: vi.fn(),
  listCouplingsFor: vi.fn(),
}));

vi.mock('../identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../identity')>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller-0000', workspaceId: 'ws-test' })),
}));
vi.mock('../recipient-resolve', () => ({ resolveExplicitAgentOwnerId: resolveExplicitAgentOwnerIdMock }));
vi.mock('../../../coord/couplings', () => ({
  COUPLING_REASON_MAX: 1000,
  declareCoupling: couplingMocks.declareCoupling,
  suppressCoupling: couplingMocks.suppressCoupling,
  listCouplingsFor: couplingMocks.listCouplingsFor,
  peerOf: (edge: { agentA: string; agentB: string }, ownerId: string) =>
    edge.agentA === ownerId ? edge.agentB : edge.agentA,
}));

import coupleTool from './couple';
import decoupleTool from './decouple';

const CALLER = 'su-caller-0000';
const PEER = 'su-a64f40ce-b081-4a33-89c9-a0581c87aa2f';
const OTHER = 'su-other-1111';

function edge(agentA: string, agentB: string, state: 'coupled' | 'suppressed') {
  const [a, b] = [agentA, agentB].sort();
  return { agentA: a!, agentB: b!, state, declaredBy: CALLER, reason: null, expiresAt: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveExplicitAgentOwnerIdMock.mockImplementation(async (raw: string) => ({
    ok: false,
    code: 'assignee_unknown',
    message: `Assignee '${raw}' does not resolve to a known workspace ownerId.`,
  }));
  couplingMocks.declareCoupling.mockImplementation(async ({ agentA, agentB }: { agentA: string; agentB: string }) =>
    edge(agentA, agentB, 'coupled'));
  couplingMocks.suppressCoupling.mockImplementation(async ({ agentA, agentB }: { agentA: string; agentB: string }) =>
    edge(agentA, agentB, 'suppressed'));
  couplingMocks.listCouplingsFor.mockImplementation(async (ownerId: string) => [edge(CALLER, ownerId === CALLER ? PEER : CALLER, 'coupled')]);
});

describe('coord coupling owner identity resolution', () => {
  it('persists a unique short prefix as the resolved full ownerId', async () => {
    resolveExplicitAgentOwnerIdMock.mockResolvedValueOnce({ ok: true, ownerId: PEER });

    const result = await coupleTool.handler({ b: 'su-a64f4' } as never, {} as never) as { data: Record<string, unknown> };

    expect(resolveExplicitAgentOwnerIdMock).toHaveBeenCalledWith('su-a64f4', CALLER, 'ws-test');
    expect(couplingMocks.declareCoupling).toHaveBeenCalledWith(expect.objectContaining({ agentA: CALLER, agentB: PEER }));
    expect(result.data).toMatchObject({ ok: true, coupled: { a: PEER, b: CALLER } });
  });

  it('refuses an unknown identity before writing a coupling', async () => {
    const result = await coupleTool.handler({ b: 'su-no-match' } as never, {} as never) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({ ok: false, error: 'unknown_recipient', unknown_recipients: ['su-no-match'] });
    expect(couplingMocks.declareCoupling).not.toHaveBeenCalled();
  });

  it('resolves both decouple identities before persisting the suppression', async () => {
    resolveExplicitAgentOwnerIdMock
      .mockResolvedValueOnce({ ok: true, ownerId: PEER })
      .mockResolvedValueOnce({ ok: true, ownerId: OTHER });

    const result = await decoupleTool.handler({ a: 'su-a64f4', b: OTHER } as never, {} as never) as { data: Record<string, unknown> };

    expect(resolveExplicitAgentOwnerIdMock).toHaveBeenNthCalledWith(1, 'su-a64f4', CALLER, 'ws-test');
    expect(resolveExplicitAgentOwnerIdMock).toHaveBeenNthCalledWith(2, OTHER, CALLER, 'ws-test');
    expect(couplingMocks.suppressCoupling).toHaveBeenCalledWith(expect.objectContaining({ agentA: PEER, agentB: OTHER }));
    expect(result.data).toMatchObject({ ok: true, decoupled: { a: PEER, b: OTHER } });
  });

  it('refuses an ambiguous identity before writing a decouple', async () => {
    resolveExplicitAgentOwnerIdMock.mockResolvedValueOnce({
      ok: false,
      code: 'assignee_ambiguous',
      message: 'Pass the full ownerId.',
      candidates: [PEER, OTHER],
    });

    const result = await decoupleTool.handler({ b: 'su-' } as never, {} as never) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      ok: false,
      error: 'unknown_recipient',
      ambiguous_recipients: [{ id: 'su-', matches: [PEER, OTHER] }],
    });
    expect(couplingMocks.suppressCoupling).not.toHaveBeenCalled();
  });
});
