import { describe, expect, it, vi } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import {
  deriveFleetControlVisibility,
  fetchPresenceFleet,
  liveSessionLogFleetFallbackOwnerIds,
  resolvePresenceFleet,
  type FleetMembership,
} from './presence-fleet';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

const LAUNCH: FleetMembership = { fleetSlug: 'launch-fleet', fleetRole: 'member' };

describe('resolvePresenceFleet', () => {
  it('uses current presence membership over stale launch environment', async () => {
    const fetcher = vi.fn(async () =>
      new Map([['su-1', { fleetSlug: 'live-fleet', fleetRole: 'leader' }]]),
    );
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual({
      fleetSlug: 'live-fleet',
      fleetRole: 'leader',
    });
  });

  it('treats a successful empty read as authoritative fleet absence', async () => {
    const fetcher = vi.fn(async () => new Map<string, FleetMembership>());
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual({
      fleetSlug: null,
      fleetRole: null,
    });
  });

  it('falls back to launch membership only when the presence read fails', async () => {
    const fetcher = vi.fn(async (): Promise<Map<string, FleetMembership>> => {
      throw new Error('pg unavailable');
    });
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual(LAUNCH);
  });

  it('uses launch membership for an unattributable caller without reading presence', async () => {
    const fetcher = vi.fn(async () => new Map<string, FleetMembership>());
    await expect(resolvePresenceFleet(undefined, LAUNCH, fetcher)).resolves.toEqual(LAUNCH);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('session-log fleet membership fallback', () => {
  it('selects only unique session-log rows whose shared liveness verdict is live', () => {
    expect(liveSessionLogFleetFallbackOwnerIds([
      { ownerId: 'live', source: 'session-log', sessionState: 'live' },
      { ownerId: 'live', source: 'session-log', sessionState: 'live' },
      { ownerId: 'recorded', source: 'session-log', sessionState: 'recorded' },
      { ownerId: 'ended', source: 'session-log-ended', sessionState: 'ended' },
      { ownerId: 'unknown', source: 'session-log', sessionState: null },
      { ownerId: 'other', source: 'coord_presence', sessionState: 'live' },
    ])).toEqual(['live']);
  });

  it('uses the latest ledger fact only for live candidates with no coord_presence row', async () => {
    const sql = vi.fn();
    const queries: string[] = [];
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join(' ');
      queries.push(query);
      if (query.includes('fleet_membership_events')) {
        return [{ owner_id: 'live', fleet_slug: 'ledger-fleet', fleet_role: 'member' }];
      }
      return [{ owner_id: 'present', fleet_slug: 'presence-fleet', fleet_role: 'leader' }];
    });
    vi.mocked(getOrgPg).mockReturnValue({ sql } as never);

    const result = await fetchPresenceFleet(
      ['present', 'unlabelled-present', 'live', 'recorded', 'ended'],
      {
        workspaceId: 'papercusp-workspace',
        liveSessionLogOwnerIds: ['present', 'unlabelled-present', 'live'],
      },
    );

    expect(result.get('present')).toEqual({ fleetSlug: 'presence-fleet', fleetRole: 'leader' });
    expect(result.get('live')).toEqual({ fleetSlug: 'ledger-fleet', fleetRole: 'member' });
    expect(result.has('unlabelled-present')).toBe(false);
    expect(result.has('recorded')).toBe(false);
    expect(result.has('ended')).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('DISTINCT ON (e.owner_id)');
    expect(queries[1]).toContain('ORDER BY e.owner_id, e.id DESC');
    expect(queries[1]).toContain('latest.fleet_slug IS NOT NULL');
    expect(queries[1]).toContain('NOT EXISTS');
    expect(queries[1]).toContain('harness_shared.coord_presence');
  });
});

/**
 * EI-22072194984361823. The reported failure: `coord:presence` showed
 * `fleet: "windows-parity"` on a live, actively-turning agent while that fleet
 * was winding-down, so a router spent a send, a dispatch and a claim before the
 * claim refusal (`fleet_winding_down`) revealed the agent could not take work at
 * all. These pin the rule that now makes the disqualifier visible up front.
 */
describe('deriveFleetControlVisibility (EI-22072194984361823)', () => {
  const WINDING = new Map([['windows-parity', { controlState: 'winding-down' as const }]]);
  const ACTIVE = new Map([['ui-fleet', { controlState: 'active' as const }]]);

  it('marks a MEMBER of a winding-down fleet as unable to acquire work', () => {
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'windows-parity', fleetRole: 'member' }, WINDING),
    ).toEqual({ fleetControlState: 'winding-down', canAcquireWork: false });
  });

  it('still reports a LEADER of that same winding-down fleet as able to acquire work', () => {
    // The asymmetry is the load-bearing part: resolveFleetScopeContext returns
    // null unless fleetRole === 'member', so fleetControlWindDownRefusal can
    // never fire for a leader. Reporting canAcquireWork:false here would invent
    // a gate the claim path does not enforce and hide a viable candidate.
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'windows-parity', fleetRole: 'leader' }, WINDING),
    ).toEqual({ fleetControlState: 'winding-down', canAcquireWork: true });
  });

  it('leaves a member of an active fleet unrestricted', () => {
    expect(deriveFleetControlVisibility({ fleetSlug: 'ui-fleet', fleetRole: 'member' }, ACTIVE)).toEqual({
      fleetControlState: 'active',
      canAcquireWork: true,
    });
  });

  it('FAILS OPEN for a slug with no fleet row rather than fabricating a gate', () => {
    // A deleted fleet, or a stale hand-set coord_presence.fleet_slug label that
    // never had a row. fleetControlWindDownRefusal refuses only on a POSITIVE
    // winding-down read, so presence must not advertise a stricter rule.
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'never-registered', fleetRole: 'member' }, WINDING),
    ).toEqual({ fleetControlState: 'active', canAcquireWork: true });
  });

  it('fails open when the batched control-state read returned nothing at all', () => {
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'windows-parity', fleetRole: 'member' }, new Map()),
    ).toEqual({ fleetControlState: 'active', canAcquireWork: true });
  });

  it('treats an agent with no fleet as ungated', () => {
    expect(deriveFleetControlVisibility({ fleetSlug: null, fleetRole: null }, WINDING)).toEqual({
      fleetControlState: 'active',
      canAcquireWork: true,
    });
  });

  it('gates ONLY the literal member role, never an unknown/absent one', () => {
    // fleet_role is a soft nullable label on coord_presence; only 'member' is
    // what resolveFleetScopeContext matches, so anything else must stay ungated.
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'windows-parity', fleetRole: null }, WINDING).canAcquireWork,
    ).toBe(true);
    expect(
      deriveFleetControlVisibility({ fleetSlug: 'windows-parity', fleetRole: 'observer' }, WINDING)
        .canAcquireWork,
    ).toBe(true);
  });
});
