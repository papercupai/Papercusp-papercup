import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordOwnerDirective: vi.fn(),
  countOpenOwnerDirectives: vi.fn(async () => 2),
  findCapturedTwin: vi.fn(async () => null),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-test' })),
  resolveRelayProvenance: vi.fn(async () => ({ stamp: null })),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return {
    ...actual,
    recordOwnerDirective: mocks.recordOwnerDirective,
    countOpenOwnerDirectives: mocks.countOpenOwnerDirectives,
    findCapturedTwin: mocks.findCapturedTwin,
  };
});
vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: mocks.resolveAgentIdentity };
});
vi.mock('../coordination/relay-provenance-resolve', () => ({ resolveRelayProvenance: mocks.resolveRelayProvenance }));
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ws-1' };
});

const captureTool = (await import('./capture')).default;
const recordTool = (await import('./record')).default;
const ctx = { workspaceId: 'ws-1' } as never;

describe('owner directive verbatim argument schemas', () => {
  beforeEach(() => {
    mocks.recordOwnerDirective.mockReset();
    mocks.recordOwnerDirective.mockResolvedValue({
      id: 71,
      verbatimText: 'yes',
      sourceTurnRef: 'session:turn-1',
      capturedByHook: true,
      dispositionStatus: null,
    });
    mocks.findCapturedTwin.mockReset();
    mocks.findCapturedTwin.mockResolvedValue(null);
  });

  it('accepts and forwards a three-character approval verbatim through both paths', async () => {
    const recordArgs = recordTool.args.parse({ verbatim: 'yes' });
    expect(recordArgs.verbatim).toBe('yes');
    await recordTool.handler(recordArgs, ctx);
    expect(mocks.recordOwnerDirective).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ verbatimText: 'yes' }),
    );

    const captureArgs = captureTool.args.parse({ verbatim: 'yes', sourceTurnRef: 'session:turn-1' });
    expect(captureArgs.verbatim).toBe('yes');
    await captureTool.handler(captureArgs, {
      workspaceId: 'ws-1',
      requestOrigin: { query: { superuser: '1', origin: 'hook' } },
    } as never);
    expect(mocks.recordOwnerDirective).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ verbatimText: 'yes', capturedByHook: true }),
    );
  });

  it('accepts and forwards complete long directives through both paths', async () => {
    const verbatim = 'x'.repeat(15_999) + '🚀\nPreserve the final requirement.\n' + 'é'.repeat(5_000);
    const recordArgs = recordTool.args.parse({ verbatim });
    await recordTool.handler(recordArgs, ctx);
    const captureArgs = captureTool.args.parse({ verbatim, sourceTurnRef: 'session:long-turn' });
    await captureTool.handler(captureArgs, {
      workspaceId: 'ws-1',
      requestOrigin: { query: { superuser: '1', origin: 'hook' } },
    } as never);

    expect(mocks.recordOwnerDirective).toHaveBeenNthCalledWith(1, expect.objectContaining({ verbatimText: verbatim }));
    expect(mocks.recordOwnerDirective).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ verbatimText: verbatim, sourceTurnRef: 'session:long-turn', capturedByHook: true }),
    );
  });

  it('continues rejecting empty directive text', () => {
    expect(recordTool.args.safeParse({ verbatim: '' }).success).toBe(false);
    expect(captureTool.args.safeParse({ verbatim: '', sourceTurnRef: 'turn-1' }).success).toBe(false);
  });
});
