import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-asker', ownerLabel: 'su · asker', workspaceId: 'ws-1' })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-fallback' }));

const openOrTouchGate = vi.fn();
const closeGate = vi.fn();
vi.mock('../../attention/gate-store', () => ({
  openOrTouchGate: (...a: unknown[]) => openOrTouchGate(...a),
  closeGate: (...a: unknown[]) => closeGate(...a),
}));

const tool = (await import('./ingest-gate-event')).default;

function callTool(args: Record<string, unknown>) {
  return (tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: Record<string, unknown> }> }).handler(
    args,
    {},
  );
}

describe('sessions:ingest-gate-event', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens a fresh ask gate, tagging the asker ownerId from identity when not passed', async () => {
    openOrTouchGate.mockResolvedValue({ id: '42', outcome: 'opened' });
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'ask', refId: 'ref-1', question: 'Q?' });
    expect(res.data).toEqual({ ok: true, gateId: '42', state: 'opened' });
    expect(openOrTouchGate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', sessionId: 's1', kind: 'ask', refId: 'ref-1', ownerId: 'su-asker', question: 'Q?' }),
    );
  });

  it('falls back to text when question is omitted', async () => {
    openOrTouchGate.mockResolvedValue({ id: '43', outcome: 'already_open' });
    const res = await callTool({ sessionId: 's1', client: 'omp', kind: 'permission_wait', refId: 'ref-2', text: 'blocked on approval' });
    expect(res.data.state).toBe('already_open');
    expect(openOrTouchGate).toHaveBeenCalledWith(expect.objectContaining({ question: 'blocked on approval', client: 'omp', kind: 'permission_wait' }));
  });

  it('an explicit ownerId overrides the identity-derived one', async () => {
    openOrTouchGate.mockResolvedValue({ id: '44', outcome: 'opened' });
    await callTool({ sessionId: 's1', client: 'claude', kind: 'ask', refId: 'ref-3', ownerId: 'su-explicit' });
    expect(openOrTouchGate).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-explicit' }));
  });

  it("kind:'cleared' closes by refId instead of opening", async () => {
    closeGate.mockResolvedValue('closed');
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'cleared', refId: 'ref-1' });
    expect(closeGate).toHaveBeenCalledWith({ workspaceId: 'ws-1', sessionId: 's1', refId: 'ref-1', reason: 'hook_cleared' });
    expect(openOrTouchGate).not.toHaveBeenCalled();
    expect(res.data).toEqual({ ok: true, gateId: null, state: 'closed' });
  });

  it("kind:'cleared' on an unknown ref reports not_found", async () => {
    closeGate.mockResolvedValue('not_found');
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'cleared', refId: 'ref-missing' });
    expect(res.data.state).toBe('not_found');
  });

  describe("kind:'suppressed_ask' admission (WI-10005039)", () => {
    const DECIDE_BY = '2026-10-09T12:00:00.000Z';
    const valid = {
      sessionId: 's1',
      client: 'claude',
      kind: 'suppressed_ask',
      refId: 'sup-1',
      question: 'Ship the migration now, or hold for the owner window?',
      decideBy: DECIDE_BY,
      defaultIfUnanswered: 'ship it at the deadline',
    };

    it('admits a complete suppressed ask as source:agent with a parsed decideBy Date + the default', async () => {
      openOrTouchGate.mockResolvedValue({ id: '77', outcome: 'opened' });
      const res = await callTool(valid);
      expect(res.data).toEqual({ ok: true, gateId: '77', state: 'opened' });
      expect(openOrTouchGate).toHaveBeenCalledTimes(1);
      const arg = openOrTouchGate.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg).toMatchObject({
        kind: 'suppressed_ask',
        source: 'agent',
        refId: 'sup-1',
        question: valid.question,
        defaultIfUnanswered: 'ship it at the deadline',
      });
      expect(arg.decideBy).toBeInstanceOf(Date);
      expect((arg.decideBy as Date).toISOString()).toBe(DECIDE_BY);
    });

    it.each([
      ['decideBy', { decideBy: undefined }],
      ['defaultIfUnanswered', { defaultIfUnanswered: undefined }],
      ['question', { question: undefined }],
    ])('REFUSES a suppressed ask missing %s, and opens no gate', async (field, over) => {
      const res = await callTool({ ...valid, ...over });
      expect(res.data).toMatchObject({ ok: false, gateId: null, state: 'refused' });
      expect(String(res.data.reason)).toContain(field);
      expect(openOrTouchGate).not.toHaveBeenCalled();
    });

    it('REFUSES an unparseable decideBy rather than persisting an Invalid Date', async () => {
      const res = await callTool({ ...valid, decideBy: 'next tuesday-ish' });
      expect(res.data).toMatchObject({ ok: false, state: 'refused' });
      expect(String(res.data.reason)).toContain('not a parseable ISO-8601');
      expect(openOrTouchGate).not.toHaveBeenCalled();
    });

    it('CONTROL: a plain ask needs neither deadline nor default, and is still source:hook', async () => {
      // If the suppressed_ask requirements ever leaked onto the plain ask path this would refuse,
      // and the refusals above would be indistinguishable from a handler that refuses everything.
      openOrTouchGate.mockResolvedValue({ id: '78', outcome: 'opened' });
      const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'ask', refId: 'plain-1', question: 'Q?' });
      expect(res.data).toMatchObject({ ok: true, state: 'opened' });
      const arg = openOrTouchGate.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.source).toBe('hook');
      expect(arg.decideBy).toBeNull();
      expect(arg.defaultIfUnanswered).toBeUndefined();
    });
  });
});
