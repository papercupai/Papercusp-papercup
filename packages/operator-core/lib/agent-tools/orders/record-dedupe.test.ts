/**
 * record-dedupe.test.ts — orders:record returns the hook's capture instead of a
 * twin (directive-ownership-clarity-2026-09-23 P-004).
 *
 * On 2026-09-23 one owner message produced two rows several times over (#269/#271,
 * #270/#272): the hook captured it under owner 'owner', then the agent recorded it
 * again under owner 'Avi' with a different turn ref, and only one twin was ever
 * closed. A re-record must hand back the captured id and write nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findCapturedTwin: vi.fn(),
  recordOwnerDirective: vi.fn(),
  countOpenOwnerDirectives: vi.fn(async () => 3),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  resolveRelayProvenance: vi.fn(async () => ({ stamp: null })),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return {
    ...actual,
    findCapturedTwin: h.findCapturedTwin,
    recordOwnerDirective: h.recordOwnerDirective,
    countOpenOwnerDirectives: h.countOpenOwnerDirectives,
  };
});
vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});
vi.mock('../coordination/relay-provenance-resolve', () => ({ resolveRelayProvenance: h.resolveRelayProvenance }));
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'papercusp-workspace' };
});

const tool = (await import('./record')).default;
const CTX = { uiClientId: 'pus-test', isPowerUser: false, workspaceId: 'papercusp-workspace' } as never;

async function call(args: Record<string, unknown>) {
  const r = (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  h.findCapturedTwin.mockReset();
  h.recordOwnerDirective.mockReset();
  h.recordOwnerDirective.mockResolvedValue({ id: 900 });
});

describe('orders:record — no twin of a hook-captured turn', () => {
  it('returns the captured row and writes nothing when the hook already captured this turn', async () => {
    h.findCapturedTwin.mockResolvedValue({ id: 269, dispositionStatus: null });

    const body = await call({ verbatim: 'okay pause your work until we implement these improvements', ownerName: 'Avi' });

    expect(body).toMatchObject({ ok: true, id: 269, deduplicated: true, state: 'open' });
    expect(String(body.note)).toContain('#269');
    expect(h.recordOwnerDirective).not.toHaveBeenCalled();
    expect(h.findCapturedTwin).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      recordedBy: 'su-mine',
      verbatimText: 'okay pause your work until we implement these improvements',
    });
  });

  it('uses an exact sourceTurnRef before text matching when recovering a committed hook capture', async () => {
    h.recordOwnerDirective.mockResolvedValue({
      id: 4243,
      sourceTurnRef: 'native-session:turn-hash',
      verbatimText: 'the same owner turn',
      capturedByHook: true,
      dispositionStatus: null,
    });

    const body = await call({
      verbatim: 'the same owner turn',
      sourceTurnRef: 'native-session:turn-hash',
    });

    expect(body).toMatchObject({ ok: true, id: 4243, deduplicated: true, state: 'open' });
    expect(h.findCapturedTwin).not.toHaveBeenCalled();
    expect(h.recordOwnerDirective).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner',
      sourceTurnRef: 'native-session:turn-hash',
      verbatimText: 'the same owner turn',
    }));
  });

  it('keeps identical text on different exact source turns as separate directives', async () => {
    h.findCapturedTwin.mockResolvedValue({ id: 269, dispositionStatus: null });
    h.recordOwnerDirective.mockResolvedValue({
      id: 900,
      sourceTurnRef: 'native-session:second-turn-hash',
      verbatimText: 'repeat this exact instruction',
      capturedByHook: false,
    });

    const body = await call({
      verbatim: 'repeat this exact instruction',
      sourceTurnRef: 'native-session:second-turn-hash',
    });

    expect(body).toMatchObject({ ok: true, id: 900 });
    expect(body.deduplicated).toBeUndefined();
    expect(h.findCapturedTwin).not.toHaveBeenCalled();
    expect(h.recordOwnerDirective).toHaveBeenCalledWith(expect.objectContaining({
      sourceTurnRef: 'native-session:second-turn-hash',
      verbatimText: 'repeat this exact instruction',
    }));
  });

  it('records a genuinely new directive under the single owner label, whatever ownerName says', async () => {
    h.findCapturedTwin.mockResolvedValue(null);

    const body = await call({ verbatim: 'an order that arrived by another channel', ownerName: 'Avi' });

    expect(body).toMatchObject({ ok: true, id: 900 });
    expect(h.recordOwnerDirective).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner', recordedBy: 'su-mine' }));
  });

  it('a failed twin lookup still records (a dropped owner order is the worse failure)', async () => {
    h.findCapturedTwin.mockRejectedValue(new Error('pg down'));

    const body = await call({ verbatim: 'an order that must not be dropped' });

    expect(body).toMatchObject({ ok: true, id: 900 });
    expect(h.recordOwnerDirective).toHaveBeenCalledTimes(1);
  });
});
