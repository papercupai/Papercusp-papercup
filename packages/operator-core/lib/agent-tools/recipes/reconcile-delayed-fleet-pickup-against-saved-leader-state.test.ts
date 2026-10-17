import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Keep this fixture synchronized with the persisted recipe via recipes:revise.
const script = readFileSync(
  new URL('./fixtures/reconcile-delayed-fleet-pickup-against-saved-leader-state.recipe.txt', import.meta.url),
  'utf8',
);

const INPUTS = {
  messageId: 'coord-current-leader-reply',
  fleetSlug: 'fleet-current',
  leaderId: 'su-current-leader',
  requesterId: 'su-current-member',
  workItemId: 'EI-26062282392843468',
  contextSince: '2026-10-15T12:00:00.000Z',
};
const OWNER = INPUTS.requesterId;
const LEADER = INPUTS.leaderId;

function run({
  message = {
    msg_id: INPUTS.messageId,
    from: LEADER,
    to: [OWNER],
    ts: '2026-10-15T12:01:00.000Z',
    summary: `Leader response for ${INPUTS.workItemId}`,
    body: 'Saved leader state is current.',
  },
} = {}) {
  const read = vi.fn(async ({ msg_id }: { msg_id: string }) => ({
    ok: true,
    found: true,
    msg_id,
    message,
  }));
  const status = vi.fn(async () => ({
    ok: true,
    ownerId: OWNER,
    carryNote: { contentHash: 'current-carry-hash', note: 'leader checkpoint' },
    rewake: { rewakeGuaranteed: true },
    pendingAwaits: { status: 'none' },
  }));
  const context = vm.createContext({
    inputs: INPUTS,
    tools: {
      coord: { read },
      loop: { status },
    },
  });
  const result = vm.runInContext(`(async () => {\n${script}\n})()`, context) as Promise<Record<string, unknown>>;
  return { result, read, status };
}

describe('reconcile-delayed-fleet-pickup-against-saved-leader-state saved recipe', () => {
  it('reads the invocation-bound message and reports it only when it matches the live leader, requester, and work item', async () => {
    const scan = run();
    const result = await scan.result;

    expect(result).toMatchObject({
      ok: true,
      message: { id: INPUTS.messageId, from: LEADER },
      owner: OWNER,
      fleet: { slug: INPUTS.fleetSlug, leaderId: LEADER },
      workItemId: INPUTS.workItemId,
      loopStatus: expect.objectContaining({
        ownerId: OWNER,
        carryNote: expect.objectContaining({ contentHash: 'current-carry-hash' }),
      }),
    });
    expect(scan.read).toHaveBeenCalledWith({ msg_id: INPUTS.messageId });
  });

  it('refuses a message that predates the current work context', async () => {
    const scan = run({
      message: {
        msg_id: INPUTS.messageId,
        from: LEADER,
        to: [OWNER],
        ts: '2026-10-07T12:01:00.000Z',
        summary: `Old leader response for ${INPUTS.workItemId}`,
        body: 'Stale saved leader state.',
      },
    });

    expect(await scan.result).toMatchObject({ ok: false, error: 'message-predates-current-context' });
  });

  it('refuses messages from a leader other than the one resolved for this invocation or messages not addressed to this session', async () => {
    const formerLeader = run({
      message: {
        msg_id: INPUTS.messageId,
        from: 'su-former-leader',
        to: [OWNER],
        ts: '2026-10-15T12:01:00.000Z',
        summary: `Leader response for ${INPUTS.workItemId}`,
        body: 'Old leader state.',
      },
    });
    expect(await formerLeader.result).toMatchObject({ ok: false, error: 'message-not-from-current-leader' });

    const wrongRecipient = run({
      message: {
        msg_id: INPUTS.messageId,
        from: LEADER,
        to: ['su-other-member'],
        ts: '2026-10-15T12:01:00.000Z',
        summary: `Leader response for ${INPUTS.workItemId}`,
        body: 'Not sent to this member.',
      },
    });
    expect(await wrongRecipient.result).toMatchObject({ ok: false, error: 'message-not-addressed-to-requester' });
  });

  it('refuses messages for another work item', async () => {
    const otherItem = run({
      message: {
        msg_id: INPUTS.messageId,
        from: LEADER,
        to: [OWNER],
        ts: '2026-10-15T12:01:00.000Z',
        summary: 'Leader response for EI-OTHER',
        body: 'Unrelated leader state.',
      },
    });
    expect(await otherItem.result).toMatchObject({ ok: false, error: 'message-does-not-reference-current-work-item' });

  });
});
