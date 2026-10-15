/**
 * P-001 (goal-mode-design-intent-hardening-2026-08-16) — the drain-fleet lane's
 * SHAPE guards.
 *
 * The load-bearing invariant is D-005: the auto-minted lane is goal-scoped via
 * the POSITIVE `{field:'goal', op:'='}` leaf, never a negation and never
 * pot-wide. A positive lane may intentionally match zero during goal setup;
 * the replacement guard covers dropping that fence later. Falsifiability is
 * proven the tier-1 way (no tree mutation): the
 * deliberately-WRONG lane shapes live permanently in this file as controls the
 * scope check must reject, beside a calibration case the real minted spec must
 * pass — so a scope check that "accepts everything" and a mint that "scopes
 * nothing" both fail here.
 *
 * Run: cd packages/operator-core && npx vitest run lib/goals/drain-fleet-mint.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createFleetMock, setLeaderMock, getFleetMock, takeLeadershipMock, setSpecMock, presenceMock, couplingMock, potHomeSlugMock } = vi.hoisted(() => ({
  createFleetMock: vi.fn(), setLeaderMock: vi.fn(), getFleetMock: vi.fn(), takeLeadershipMock: vi.fn(), setSpecMock: vi.fn(),
  presenceMock: vi.fn(), couplingMock: vi.fn(), potHomeSlugMock: vi.fn(),
}));
vi.mock('../agent-fleets-store', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  createFleetIfAbsent: createFleetMock,
  setFleetLeader: setLeaderMock,
  getFleet: getFleetMock,
}));
vi.mock('../scheduler/claim-spec-store', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  setClaimSpec: setSpecMock,
}));
vi.mock('../hive-federation', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  potHomeSlugForHarness: potHomeSlugMock,
}));
vi.mock('../agent-tools/coordination/presence', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  setPresenceFleet: presenceMock,
}));
vi.mock('../coord/couplings', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  declareCoupling: couplingMock,
}));
vi.mock('../agent-tools/fleet_registry/take-leadership-core', () => ({
  takeFleetLeadership: (...a: unknown[]) => takeLeadershipMock(...a),
}));

import { validateClaimSpec } from '../scheduler/claim-spec';
import { claimSpecIsGoalScoped } from '../system-health/goal-drain-fleet-watchdog';
import { buildGoalDrainClaimSpec, drainFleetSlugForGoal, mintDrainFleetForGoal, registerGoalDrainFleetLeader } from './drain-fleet-mint';

beforeEach(() => {
  vi.clearAllMocks();
  createFleetMock.mockResolvedValue({ created: true, record: {} });
  setLeaderMock.mockResolvedValue({});
  getFleetMock.mockResolvedValue({
    workspaceId: 'ws', fleetSlug: 'goal-drain-g-1', leaderOwnerId: 'su-old',
  });
  takeLeadershipMock.mockResolvedValue({
    leader: 'su-new', previousLeader: 'su-old', control: { errors: [] },
  });
  setSpecMock.mockResolvedValue({ ok: true, revision: 1, errors: [] });
  presenceMock.mockResolvedValue(null);
  couplingMock.mockResolvedValue({ state: 'coupled' });
  potHomeSlugMock.mockResolvedValue('papercusp-home');
});

describe('P-014 delegated drain leadership', () => {
  it('mints a positive goal lane under a truthfully leaderless fleet row', async () => {
    const goalTx = vi.fn(async () => []);
    await mintDrainFleetForGoal({
      workspaceId: 'ws', harnessSlug: 'papercusp-test', goalId: 'g-1', goalTitle: 'Goal', agentOwnerId: 'su-holder',
      goalTx: goalTx as never,
    });
    expect(potHomeSlugMock).toHaveBeenCalledWith('ws', 'papercusp-test');
    expect(createFleetMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'su-holder', leaderOwnerId: null,
    }));
    expect(setSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws', potSlug: 'papercusp-home', spec: expect.objectContaining({
        view: { filter: { field: 'goal', op: '=', value: 'g-1' } },
      }),
    }));
  });

  it('does not couple or label a leader when the registry snapshot no longer matches the CAS', async () => {
    getFleetMock.mockResolvedValueOnce({
      workspaceId: 'ws', fleetSlug: 'goal-drain-g-1', leaderOwnerId: 'su-current',
    });
    const result = await registerGoalDrainFleetLeader({
      workspaceId: 'ws', goalId: 'g-1', fleetSlug: 'goal-drain-g-1',
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-leader',
      declaredBy: 'goal-drain-fleet-watchdog', expectedLeaderOwnerId: 'su-old',
      identity: { ownerId: 'su-watchdog', ownerLabel: 'watchdog', source: 'principal', workspaceId: 'ws', userId: null },
    });
    expect(result.registered).toBe(false);
    expect(takeLeadershipMock).not.toHaveBeenCalled();
    expect(setLeaderMock).not.toHaveBeenCalled();
    expect(presenceMock).not.toHaveBeenCalled();
    expect(couplingMock).not.toHaveBeenCalled();
  });

  it('uses the shared leadership transfer before coupling the replacement leader', async () => {
    couplingMock.mockResolvedValueOnce(null);
    const identity = {
      ownerId: 'su-watchdog', ownerLabel: 'watchdog', source: 'principal', workspaceId: 'ws', userId: null,
    } as const;
    const result = await registerGoalDrainFleetLeader({
      workspaceId: 'ws', goalId: 'g-1', fleetSlug: 'goal-drain-g-1',
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-new',
      declaredBy: 'goal-drain-fleet-watchdog', expectedLeaderOwnerId: 'su-old',
      identity,
      harnessSlug: 'papercusp-test',
    });
    expect(result).toMatchObject({ registered: true, coupled: false });
    expect(takeLeadershipMock).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ fleetSlug: 'goal-drain-g-1', leaderOwnerId: 'su-old' }),
      identity,
      'su-new',
      { harnessSlug: 'papercusp-test' },
    );
    expect(setLeaderMock).not.toHaveBeenCalled();
    expect(presenceMock).not.toHaveBeenCalled();
    expect(couplingMock).toHaveBeenCalledWith(expect.objectContaining({
      agentA: 'su-holder', agentB: 'su-new', declaredBy: 'goal-drain-fleet-watchdog',
    }));
  });

  it('refuses to replace a recorded leader without an actor identity', async () => {
    const result = await registerGoalDrainFleetLeader({
      workspaceId: 'ws', goalId: 'g-1', fleetSlug: 'goal-drain-g-1',
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-new',
      declaredBy: 'goal-drain-fleet-watchdog', expectedLeaderOwnerId: 'su-old',
    });
    expect(result).toMatchObject({ registered: false, coupled: false });
    expect(result.warning).toContain('requires an actor identity');
    expect(setLeaderMock).not.toHaveBeenCalled();
    expect(presenceMock).not.toHaveBeenCalled();
    expect(couplingMock).not.toHaveBeenCalled();
  });

  it('allows an identity-less initial install only into a leaderless fleet', async () => {
    getFleetMock.mockResolvedValueOnce({
      workspaceId: 'ws', fleetSlug: 'goal-drain-g-1', leaderOwnerId: null,
    });
    const result = await registerGoalDrainFleetLeader({
      workspaceId: 'ws', goalId: 'g-1', fleetSlug: 'goal-drain-g-1',
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-new',
      declaredBy: 'operator-ui', expectedLeaderOwnerId: null,
    });
    expect(result.registered).toBe(true);
    expect(setLeaderMock).toHaveBeenCalledWith('ws', 'goal-drain-g-1', 'su-new', undefined, null);
    expect(presenceMock).toHaveBeenCalledWith('ws', 'su-new', 'goal-drain-g-1', 'leader');
    expect(takeLeadershipMock).not.toHaveBeenCalled();
  });
});

describe('drainFleetSlugForGoal', () => {
  it('is goal-drain-<goalId> when the id fits the slug budget', () => {
    expect(drainFleetSlugForGoal('ship-paid-app-3f9a1c')).toBe('goal-drain-ship-paid-app-3f9a1c');
  });

  it('never exceeds the 60-char fleet-slug budget', () => {
    // goalId() caps its stem at 48 chars + '-' + 6 hex = 55; prefix pushes past 60.
    const long = `${'x'.repeat(48)}-3f9a1c`;
    expect(drainFleetSlugForGoal(long).length).toBeLessThanOrEqual(60);
  });

  it('trims the READABLE stem, preserving the collision-resistant tail', () => {
    // Two goals whose long titles share a 48-char stem differ ONLY in the hex
    // tail — a plain right-truncation would map both to the same fleet.
    const a = drainFleetSlugForGoal(`${'x'.repeat(48)}-aaaaaa`);
    const b = drainFleetSlugForGoal(`${'x'.repeat(48)}-bbbbbb`);
    expect(a).not.toBe(b);
    expect(a.endsWith('-aaaaaa')).toBe(true);
    expect(b.endsWith('-bbbbbb')).toBe(true);
  });
});

describe('buildGoalDrainClaimSpec — the D-005 lane', () => {
  it('is a VALID spec — validateClaimSpec accepts it verbatim', () => {
    const v = validateClaimSpec(buildGoalDrainClaimSpec('ship-paid-app-3f9a1c'));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('scopes with the POSITIVE = leaf on the goal field — the WI-37711 rule', () => {
    const spec = buildGoalDrainClaimSpec('g-1') as { view: { filter: unknown } };
    expect(spec.view.filter).toEqual({ field: 'goal', op: '=', value: 'g-1' });
  });

  it('CALIBRATION: the minted spec passes the watchdog scope check for ITS goal and no other', () => {
    const spec = buildGoalDrainClaimSpec('g-1');
    expect(claimSpecIsGoalScoped(spec, 'g-1')).toBe(true);
    expect(claimSpecIsGoalScoped(spec, 'g-2')).toBe(false);
  });

  /**
   * CONTROLS — the wrong lane shapes, kept permanently so the guard pair stays
   * falsifiable. Each is a spec a plausible-but-broken mint could produce; the
   * watchdog scope check MUST reject every one, or an unscoped drain fleet
   * would read as healthy (the exact pre-D-005 gap).
   */
  it('CONTROL: the NEGATIVE form is not an ownership fence and must not count as scoped', () => {
    const negated = {
      ...buildGoalDrainClaimSpec('g-1'),
      view: { filter: { not: { field: 'goal', op: '=', value: 'g-1' } } },
    };
    expect(claimSpecIsGoalScoped(negated, 'g-1')).toBe(false);
  });

  it('CONTROL: a pot-wide lane (the DEFAULT_CLAIM_SPEC shape) must not count as scoped', () => {
    const potWide = { ...buildGoalDrainClaimSpec('g-1'), view: {} };
    expect(claimSpecIsGoalScoped(potWide, 'g-1')).toBe(false);
  });

  it('CONTROL: a lane scoped to a DIFFERENT field is not goal-scoped either', () => {
    const planScoped = {
      ...buildGoalDrainClaimSpec('g-1'),
      view: { filter: { field: 'plan', op: '=', value: 'g-1' } },
    };
    expect(claimSpecIsGoalScoped(planScoped, 'g-1')).toBe(false);
  });
});
