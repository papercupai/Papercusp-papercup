/**
 * messages.role-live-delivery.test.ts — EI-13620 regression.
 *
 * Root cause: sendMessage ALWAYS excluded a `role` slot from live delivery —
 * `@role:mug` parked unconditionally, even when a session was ALREADY,
 * CURRENTLY running as the Mug. Deliver-on-spawn (mug-brief-launch.ts) only
 * drains that park store at the role's next LAUNCH, never on an existing
 * session's plain wake — so a correction nudge to a stable, live-but-idle Mug
 * silently sat (coord:send returning ok with targets:[]/woken:0) until some
 * future relaunch that might not happen for hours (the live incident this
 * covers: EI-13620 itself sat unplaced ~5h this way).
 *
 * This guards the fix: sendMessage now ALSO resolves a role slot against the
 * live roster (./role-slot-live-resolve, unit-tested separately) and, when a
 * live holder is found, delivers to it exactly like an ordinary ownerId send
 * — in ADDITION to the unconditional park (so a future relaunch still drains
 * it too, unchanged).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
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
vi.mock('./role-slot-live-resolve', () => ({
  resolveLiveRoleHolders: vi.fn(async () => [] as string[]),
  resolveRoleSlotPotSlug: vi.fn(async () => null),
}));

import { sendMessage } from './messages';
import { parkSlotMessage } from './slot-parked-store';
import { coordLog } from './log';
import { resolveLiveRoleHolders } from './role-slot-live-resolve';

const identity = { ownerId: 'kettle-sender', workspaceId: 'ws-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendMessage — @role: live-holder delivery (EI-13620)', () => {
  it('delivers to a role slot\'s CURRENTLY live holder AND still parks it', async () => {
    vi.mocked(resolveLiveRoleHolders).mockResolvedValue(['mug-owner-live']);
    const env = await sendMessage(identity, { to: ['@role:mug'], summary: 'placement correction' });
    // Legacy park-for-future-spawn is UNCHANGED — a future relaunch still drains it.
    expect(parkSlotMessage).toHaveBeenCalledTimes(1);
    // NEW: also delivered live — this is the targets:[]/woken:0 fix.
    expect(coordLog.appendLine).toHaveBeenCalledTimes(1);
    expect(env.to).toEqual(['mug-owner-live']);
  });

  it('parks ONLY (no live delivery) when no live holder is found — legacy behavior preserved', async () => {
    vi.mocked(resolveLiveRoleHolders).mockResolvedValue([]);
    const env = await sendMessage(identity, { to: ['@role:mug'], summary: 'nudge' });
    expect(parkSlotMessage).toHaveBeenCalledTimes(1);
    expect(coordLog.appendLine).not.toHaveBeenCalled();
    expect(env.to).toEqual([]);
  });

  it('a mixed send still delivers to the concrete addressee AND the resolved live role holder', async () => {
    vi.mocked(resolveLiveRoleHolders).mockResolvedValue(['mug-owner-live']);
    const env = await sendMessage(identity, { to: ['@role:mug', 'alice'], summary: 's' });
    expect(env.to.slice().sort()).toEqual(['alice', 'mug-owner-live']);
  });

  it('dedupes when multiple role slots resolve overlapping live owners', async () => {
    vi.mocked(resolveLiveRoleHolders).mockImplementation(async (role: string) =>
      role === 'mug' ? ['owner-a'] : ['owner-a', 'owner-b'],
    );
    const env = await sendMessage(identity, { to: ['@role:mug', '@role:kettle'], summary: 's' });
    expect(env.to.slice().sort()).toEqual(['owner-a', 'owner-b']);
  });

  it('a non-role slot (@wave:) is unaffected — still parks only, never queries role resolution', async () => {
    const env = await sendMessage(identity, { to: ['@wave:W-03'], summary: 's' });
    expect(resolveLiveRoleHolders).not.toHaveBeenCalled();
    expect(parkSlotMessage).toHaveBeenCalledTimes(1);
    expect(coordLog.appendLine).not.toHaveBeenCalled();
    expect(env.to).toEqual([]);
  });
});
