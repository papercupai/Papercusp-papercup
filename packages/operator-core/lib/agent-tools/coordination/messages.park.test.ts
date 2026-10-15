/**
 * messages.park.test.ts — park-for-slot routing in sendMessage (B2, P-025; D-005).
 *
 * Verifies the send-path fork without a DB: a slot-addressed `to[]` (@role/@wave/
 * @feature) PARKS (slot-parked-store) instead of delivering; non-slot addressees
 * still deliver to the inbox; a mixed send does both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  // Only the pg handle is faked — the generated schema exports must survive
  // (agent-mcp's bootstrap, pulled in transitively via cue-authority-resolve's
  // classifyAgentPane import, reads them at module load — EI/WI-4159-adjacent).
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()), listRecordedLiveSessions: vi.fn(async () => []) }));
vi.mock('./slot-parked-store', () => ({ parkSlotMessage: vi.fn(async () => ({ id: 'x' })) }));
vi.mock('./federation-scope', () => ({
  resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
}));
// The nursery-alias leg (EI-21987499463893160) is a real PG read inside the
// addressee resolver; with the faked `sql` handle above it would fall into its
// best-effort console.warn and trip vitest-fail-on-console (EI-22125768448497294).
vi.mock('./nursery-alias-liveness', () => ({
  listRunningNurseryAliasRows: vi.fn(async () => []),
}));
vi.mock('./log', () => ({
  coordLog: { appendLine: vi.fn(async () => undefined) },
  coordSql: () => ({}),
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => false,
}));

import { sendMessage } from './messages';
import { parkSlotMessage } from './slot-parked-store';
import { coordLog } from './log';

const identity = { ownerId: 'sender' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendMessage park-for-slot routing', () => {
  it('parks a slot-only send and does NOT append to the live inbox', async () => {
    await sendMessage(identity, { to: ['@wave:W-03'], summary: 's', harnessSlug: 'h' });
    expect(parkSlotMessage).toHaveBeenCalledTimes(1);
    const arg = (parkSlotMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(arg.slot).toEqual({ kind: 'wave', ref: 'W-03' });
    expect(arg.harnessSlug).toBe('h');
    expect(coordLog.appendLine).not.toHaveBeenCalled();
  });

  it('parks the slot AND delivers to the live addressee on a mixed send', async () => {
    await sendMessage(identity, { to: ['@role:scoper', 'alice'], summary: 's' });
    expect(parkSlotMessage).toHaveBeenCalledTimes(1);
    expect((parkSlotMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].slot).toEqual({
      kind: 'role',
      ref: 'scoper',
    });
    expect(coordLog.appendLine).toHaveBeenCalledTimes(1);
    const env = (coordLog.appendLine as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(env.to).toEqual(['alice']);
  });

  it('does not park a normal (no-slot) send', async () => {
    await sendMessage(identity, { to: ['alice', 'bob'], summary: 's' });
    expect(parkSlotMessage).not.toHaveBeenCalled();
    expect(coordLog.appendLine).toHaveBeenCalledTimes(1);
  });

  it('parks each distinct slot once on a multi-slot send', async () => {
    await sendMessage(identity, { to: ['@wave:W-01', '@feature:F-009'], summary: 's', harnessSlug: 'h' });
    expect(parkSlotMessage).toHaveBeenCalledTimes(2);
    expect(coordLog.appendLine).not.toHaveBeenCalled();
  });
});
