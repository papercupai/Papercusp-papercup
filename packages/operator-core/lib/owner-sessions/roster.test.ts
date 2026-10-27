/**
 * mobile-agent-sessions-2026-10-12 P-001 (ITEM-P-001-1): the device session
 * list reads the SAME roster as the desktop Sessions roster. Both go through
 * `readSessionRoster`; this pins the desktop `advRoster.list` sync query and
 * the shared reader to identical rows for one workspace fixture, so a fork in
 * either (its own endedLimit, its own projection, its own fan-out) fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const snapshot = {
    active: [
      {
        ownerId: 'su-live', sessionState: 'live', transcriptFresh: true, thinking: 'editing',
        machineLabel: 'box', isLocal: true, fleetSlug: 'f1', fleetColor: '#123456',
        intent: 'P-001 shared modules', currentPlanSlug: 'mobile-agent-sessions-2026-10-12',
      },
      {
        ownerId: 'su-parked', sessionState: 'parked', transcriptFresh: false, thinking: null,
        machineLabel: 'box', isLocal: true, fleetSlug: null, fleetColor: null,
        intent: null, currentPlanSlug: null,
      },
    ],
    ended: [{ ownerId: 'su-ended', sessionState: 'ended' }],
    orphanedClaims: [],
    pending: [],
    starting: [],
  };
  return { snapshot, readAdvRoster: vi.fn() };
});

vi.mock('../sync-resolver/adv-roster-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync-resolver/adv-roster-read')>()),
  readAdvRoster: (opts: unknown) => fixture.readAdvRoster(opts),
}));

import { resolveNamedQueryV2 } from '../sync-resolver/index';
import { readSessionRoster, SESSION_ROSTER_DEFAULT_ENDED_LIMIT } from './roster';

beforeEach(() => {
  fixture.readAdvRoster.mockReset().mockResolvedValue(fixture.snapshot);
});

describe('session roster — one read for desktop and device (P-001)', () => {
  it('returns the same rows as the desktop advRoster.list query for the same workspace', async () => {
    const desktop = await resolveNamedQueryV2('advRoster.list', { workspaceId: 'ws-a' });
    const shared = await readSessionRoster({ workspaceId: 'ws-a' });
    expect(desktop).toEqual([shared]);
    expect(fixture.readAdvRoster.mock.calls).toEqual([
      [{ workspaceId: 'ws-a', endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT }],
      [{ workspaceId: 'ws-a', endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT }],
    ]);
  });

  it('scopes the read to the caller workspace', async () => {
    await readSessionRoster({ workspaceId: 'ws-b' });
    expect(fixture.readAdvRoster).toHaveBeenCalledWith({ workspaceId: 'ws-b', endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT });
  });

  it('applies the same header projection as the desktop pill', async () => {
    const desktop = await resolveNamedQueryV2('advRoster.list', { workspaceId: 'ws-a', view: 'header' });
    const shared = await readSessionRoster({ workspaceId: 'ws-a', view: 'header' });
    expect(desktop).toEqual([shared]);
    // The header projection keeps BOTH living and between-turn (parked) sessions since 6e19cf7d91 —
    // a parked su is still the owner's session, just idle between turns.
    expect((shared as { active: Array<{ ownerId: string }> }).active.map((a) => a.ownerId)).toEqual(['su-live', 'su-parked']);
  });
});
