/**
 * tools/retract.test.ts — the coord:retract HANDLER (coord-authority-hardening-
 * 2026-07-11 P-011 / WI-4176, H5c). Engine fns mocked (the send.test.ts /
 * control-core.test.ts recipe). Pins the ORCHESTRATION contract:
 *   • lookup → cannot_retract_retraction → alreadyRetracted (BEFORE the guard)
 *     → invoker guard → notice → optional concrete-only wake;
 *   • the notice: from the 'system:coord-retract' principal, to the ORIGINAL
 *     audience verbatim, related_msg_id + RETRACTS_FIELD = the retracted id;
 *   • a refusal writes NOTHING;
 *   • wake:true wakes concrete ownerIds only ('*'/'human'/@selectors skipped).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/retract.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLinesMock } = vi.hoisted(() => ({ readLinesMock: vi.fn(async () => [] as unknown[]) }));

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', workspaceId: 'ws1' })) }));
vi.mock('../messages', () => ({ sendMessage: vi.fn(async () => ({ msg_id: 'notice-1', ts: 't1' })), getMessageById: vi.fn(async () => null) }));
vi.mock('../presence', () => ({ getPresence: vi.fn(async () => null) }));
vi.mock('../presence-fleet', () => ({ fetchPresenceFleet: vi.fn(async () => new Map()) }));
vi.mock('../audience-host', () => ({ hostAudienceResolvers: { listFleetLeader: vi.fn(async () => []) } }));
vi.mock('../inbox-wake', () => ({ wakeRecipients: vi.fn(async () => ({ targets: [], woken: 1, staged: 0, stagedTargets: [] })) }));
// Only the store read is mocked; pickUnreadCursor stays the real shared rule.
vi.mock('../watermarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../watermarks')>()),
  readWatermark: vi.fn(async () => ({})),
}));
// fast path OFF ⇒ findExistingRetraction rides the coordLog.readLines seam.
vi.mock('../log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: vi.fn(),
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => false,
}));

import { resolveAgentIdentity } from '../identity';
import { getMessageById, sendMessage } from '../messages';
import { getPresence } from '../presence';
import { fetchPresenceFleet } from '../presence-fleet';
import { hostAudienceResolvers } from '../audience-host';
import { wakeRecipients } from '../inbox-wake';
import { readWatermark, emptyWatermark, type Watermark } from '../watermarks';
import { RETRACTS_FIELD } from '../retraction';
import type { AgentIdentity } from '../identity';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { mockImplementationTyped, mockResolvedOnceTyped, mockResolvedTyped, mockReturnTyped } from '../../../testing/typed-mock';

const identityM = vi.mocked(resolveAgentIdentity);
const getByIdM = vi.mocked(getMessageById);
const sendM = vi.mocked(sendMessage);
const getPresenceM = vi.mocked(getPresence);
const fleetM = vi.mocked(fetchPresenceFleet);
const leaderM = vi.mocked(hostAudienceResolvers.listFleetLeader);
const wakeM = vi.mocked(wakeRecipients);
const watermarkM = vi.mocked(readWatermark);

const { default: tool, RETRACT_NOTICE_OWNER } = await import('./retract');

type ToolResult = { isError?: boolean; content: [{ type: 'text'; text: string }] };
const call = async (args: unknown) => {
  const res = (await tool.handler(args as never, {} as never)) as ToolResult;
  return { ...JSON.parse(res.content[0].text), isError: res.isError === true };
};

function original(p: Record<string, unknown> = {}) {
  return {
    ts: '2026-07-11T11:00:00.000Z',
    msg_id: 'm-orig',
    from: 'sender-1',
    to: ['bob', 'carol'],
    kind: 'message',
    summary: 'WRONG: stop all work',
    plan_slug: 'plan-a',
    ...p,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  identityM.mockReturnValue({ ownerId: 'me', workspaceId: 'ws1' } as never);
  getByIdM.mockResolvedValue(null as never);
  sendM.mockResolvedValue({ msg_id: 'notice-1', ts: 't1' } as never);
  getPresenceM.mockResolvedValue(null as never);
  fleetM.mockResolvedValue(new Map() as never);
  leaderM.mockResolvedValue([] as never);
  readLinesMock.mockResolvedValue([]);
  mockResolvedTyped(watermarkM, emptyWatermark());
});

describe('coord:retract lookup + idempotency', () => {
  it('message_not_found when the msg_id resolves to nothing', async () => {
    const out = await call({ msg_id: 'nope' });
    expect(out.isError).toBe(true);
    expect(out.error).toBe('message_not_found');
    expect(sendM).not.toHaveBeenCalled();
  });

  it('refuses to retract a retraction notice (cannot_retract_retraction)', async () => {
    getByIdM.mockResolvedValue(original({ [RETRACTS_FIELD]: 'm-earlier' }) as never);
    const out = await call({ msg_id: 'm-orig' });
    expect(out.isError).toBe(true);
    expect(out.error).toBe('cannot_retract_retraction');
    expect(sendM).not.toHaveBeenCalled();
  });

  it('alreadyRetracted BEFORE the guard: an unauthorized caller still gets the harmless read, no duplicate notice', async () => {
    getByIdM.mockResolvedValue(original() as never);
    // The seam window contains an existing notice targeting m-orig.
    readLinesMock.mockResolvedValue([
      { ts: 't-n', msg_id: 'n-old', from: RETRACT_NOTICE_OWNER, to: ['bob'], kind: 'message', [RETRACTS_FIELD]: 'm-orig' },
    ]);
    identityM.mockReturnValue({ ownerId: 'total-stranger', workspaceId: 'ws1' } as never);
    const out = await call({ msg_id: 'm-orig' });
    expect(out).toMatchObject({ ok: true, msg_id: 'm-orig', alreadyRetracted: true });
    expect(sendM).not.toHaveBeenCalled();
    // Guard IO never ran — idempotency short-circuits first.
    expect(getPresenceM).not.toHaveBeenCalled();
  });
});

describe('coord:retract invoker guard', () => {
  it('the original sender retracts (invokedAs sender); notice from the system principal to the ORIGINAL audience', async () => {
    identityM.mockReturnValue({ ownerId: 'sender-1', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original() as never);
    const out = await call({ msg_id: 'm-orig', reason: 'sent to the wrong fleet' });
    expect(out).toMatchObject({ ok: true, retracted: true, invokedAs: 'sender', notice_msg_id: 'notice-1' });
    expect(sendM).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendM.mock.calls[0] as unknown as [
      { ownerId: string },
      { to: string[]; summary: string; plan_slug?: string; related_msg_id?: string; extra?: Record<string, unknown> },
    ];
    expect(identity.ownerId).toBe(RETRACT_NOTICE_OWNER);
    expect(opts.to).toEqual(['bob', 'carol']); // ORIGINAL audience verbatim
    expect(opts.related_msg_id).toBe('m-orig');
    expect(opts.extra?.[RETRACTS_FIELD]).toBe('m-orig');
    expect(opts.plan_slug).toBe('plan-a'); // carried from the original
    expect(opts.summary).toContain('⛔ RETRACTED');
    expect(opts.summary).toContain('m-orig');
    expect(opts.summary).toContain('sent to the wrong fleet');
    // Framed as withdrawing the MESSAGE, not undoing what it reported (WI-10004819).
    expect(opts.summary).toContain('withdraws the message, not any action it reported');
    // Sender identity-match ⇒ no fleet-leader lookup needed.
    expect(fleetM).not.toHaveBeenCalled();
  });

  it("the SENDER's fleet leader retracts (invokedAs leader)", async () => {
    identityM.mockReturnValue({ ownerId: 'leader-9', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original() as never);
    fleetM.mockResolvedValue(new Map([['sender-1', { fleetSlug: 'alpha' }]]) as never);
    leaderM.mockResolvedValue(['leader-9'] as never);
    const out = await call({ msg_id: 'm-orig' });
    expect(out).toMatchObject({ ok: true, invokedAs: 'leader' });
    expect(leaderM).toHaveBeenCalledWith('alpha');
  });

  it('a queen pane (mug role) retracts anyone (invokedAs queen); an su pane as owner', async () => {
    getByIdM.mockResolvedValue(original() as never);
    identityM.mockReturnValue({ ownerId: 'brain-1', workspaceId: 'ws1' } as never);
    getPresenceM.mockResolvedValue({ agentRole: 'mug' } as never);
    expect((await call({ msg_id: 'm-orig' })).invokedAs).toBe('queen');

    identityM.mockReturnValue({ ownerId: 'su-abc123', workspaceId: 'ws1' } as never);
    getPresenceM.mockResolvedValue(null as never); // role-less su-… id classifies as su
    expect((await call({ msg_id: 'm-orig' })).invokedAs).toBe('owner');
  });

  it('everyone else is refused with NOTHING written', async () => {
    identityM.mockReturnValue({ ownerId: 'random-peer', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original() as never);
    getPresenceM.mockResolvedValue({ agentRole: 'worker' } as never); // → cup pane
    const out = await call({ msg_id: 'm-orig' });
    expect(out.isError).toBe(true);
    expect(out.error).toBe('not_authorized');
    expect(out.message).toContain('sender-1');
    expect(sendM).not.toHaveBeenCalled();
    expect(wakeM).not.toHaveBeenCalled();
  });
});

describe('coord:retract never-shown recipients (WI-10004819)', () => {
  // The envelope is sent at 11:00Z: a cursor before it means never shown.
  const cursors: Record<string, Partial<Watermark>> = {
    bob: { messages_since_ts: '2026-07-11T10:00:00.000Z' },
    carol: { messages_shown_ts: '2026-07-11T11:05:00.000Z' },
  };
  const sender: AgentIdentity = { ownerId: 'sender-1', ownerLabel: 'sender-1', source: 'principal', workspaceId: 'ws1', userId: null };
  const envelope = (to: string[], p: Partial<CoordEnvelope> = {}): CoordEnvelope => ({
    ts: '2026-07-11T11:00:00.000Z',
    msg_id: 'm-orig',
    from: 'sender-1',
    to,
    kind: 'message',
    summary: 'WRONG: stop all work',
    plan_slug: 'plan-a',
    ...p,
  });

  beforeEach(() => {
    mockReturnTyped(identityM, sender);
    mockImplementationTyped(watermarkM, async (id: string) => ({ ...emptyWatermark(), ...cursors[id] }));
  });

  it('a recipient whose cursor is BEFORE the original gets a content-free notice; one at/after it gets the quote', async () => {
    mockResolvedTyped(getByIdM, envelope(['bob', 'carol']));
    mockResolvedOnceTyped(sendM, envelope([], { msg_id: 'notice-seen' }));
    mockResolvedOnceTyped(sendM, envelope([], { msg_id: 'notice-unseen' }));
    const out = await call({ msg_id: 'm-orig', reason: "interferes with a peer's live measurement" });

    expect(sendM).toHaveBeenCalledTimes(2);
    const [, quoted] = sendM.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; extra?: Record<string, unknown> }];
    const [, bare] = sendM.mock.calls[1] as unknown as [
      unknown,
      { to: string[]; summary: string; body: string; related_msg_id?: string; extra?: Record<string, unknown> },
    ];
    expect(quoted.to).toEqual(['carol']);
    expect(quoted.summary).toContain('WRONG: stop all work');
    expect(bare.to).toEqual(['bob']);
    // Neither the subject nor the reason reaches a recipient who never saw the original.
    for (const text of [bare.summary, bare.body]) {
      expect(text).not.toContain('WRONG: stop all work');
      expect(text).not.toContain('live measurement');
    }
    expect(bare.summary).toContain('m-orig');
    // Both notices carry the retraction marker (suppression + idempotency).
    expect(bare.related_msg_id).toBe('m-orig');
    expect(bare.extra?.[RETRACTS_FIELD]).toBe('m-orig');
    expect(quoted.extra?.[RETRACTS_FIELD]).toBe('m-orig');
    expect(out).toMatchObject({
      ok: true,
      notice_msg_id: 'notice-seen',
      unseenRecipients: ['bob'],
      notices: [
        { msg_id: 'notice-seen', to: ['carol'], quoted: true },
        { msg_id: 'notice-unseen', to: ['bob'], quoted: false },
      ],
    });
  });

  it('no receipt on record, a failed read, the sender, and broadcast targets all stay on the quoting notice', async () => {
    mockResolvedTyped(getByIdM, envelope(['*', 'sender-1', 'dave', 'erin']));
    mockImplementationTyped(watermarkM, async (id: string) => {
      if (id === 'erin') throw new Error('pg down');
      return id === 'sender-1' ? { ...emptyWatermark(), messages_since_ts: '2026-07-11T09:00:00.000Z' } : emptyWatermark();
    });
    const out = await call({ msg_id: 'm-orig' });
    expect(sendM).toHaveBeenCalledTimes(1);
    expect((sendM.mock.calls[0] as unknown as [unknown, { to: string[] }])[1].to).toEqual(['*', 'sender-1', 'dave', 'erin']);
    expect(out.unseenRecipients).toBeUndefined();
  });

  it('wake:true does not wake a recipient that was never shown the original', async () => {
    mockResolvedTyped(getByIdM, envelope(['bob', 'carol']));
    await call({ msg_id: 'm-orig', wake: true });
    expect((wakeM.mock.calls[0] as unknown[])[0]).toEqual(['carol']);
  });

  it('when every recipient was never shown it, only the content-free notice is sent and nobody is woken', async () => {
    mockResolvedTyped(getByIdM, envelope(['bob']));
    const out = await call({ msg_id: 'm-orig', wake: true });
    expect(sendM).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, notice_msg_id: 'notice-1', woken: 0, notices: [{ to: ['bob'], quoted: false }] });
    expect(wakeM).not.toHaveBeenCalled();
  });
});

describe('coord:retract wake', () => {
  it('wake:true wakes CONCRETE recipients only — *, human, and @selectors are skipped', async () => {
    identityM.mockReturnValue({ ownerId: 'sender-1', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original({ to: ['*', 'human', '@fleet:alpha', 'bob'] }) as never);
    const out = await call({ msg_id: 'm-orig', wake: true });
    expect(out).toMatchObject({ ok: true, woken: 1 });
    expect(wakeM).toHaveBeenCalledTimes(1);
    expect((wakeM.mock.calls[0] as unknown[])[0]).toEqual(['bob']);
  });

  it('a pure-broadcast audience with wake:true wakes nobody (woken 0), no wake call', async () => {
    identityM.mockReturnValue({ ownerId: 'sender-1', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original({ to: ['*'] }) as never);
    const out = await call({ msg_id: 'm-orig', wake: true });
    expect(out).toMatchObject({ ok: true, woken: 0 });
    expect(wakeM).not.toHaveBeenCalled();
  });

  it('without wake, no wake call and no woken field', async () => {
    identityM.mockReturnValue({ ownerId: 'sender-1', workspaceId: 'ws1' } as never);
    getByIdM.mockResolvedValue(original() as never);
    const out = await call({ msg_id: 'm-orig' });
    expect(out.woken).toBeUndefined();
    expect(wakeM).not.toHaveBeenCalled();
  });
});
