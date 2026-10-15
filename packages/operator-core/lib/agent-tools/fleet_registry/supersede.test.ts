/**
 * supersede.test.ts — fleet:supersede (WI-2034601 fix 2): composes
 * fleet:take-leadership + a TERMINAL fleet:wind-down so a predecessor fleet's
 * controller can be stood down in one call, instead of an agent having to
 * discover and hand-chain the two-step recipe (or, as observed, never doing
 * so — WI-2034601's predecessor sat controlState='active' for days).
 *
 * take-leadership-core and control-core are already unit-tested directly;
 * this test mocks THEM (not their internals) so it verifies supersede.ts's
 * own composition/validation logic: successor-must-exist, successor-must-have
 * a live leader, self-supersede refused, and leadership is recovered ONLY
 * when the predecessor's own registered leader is not live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  getPresence: vi.fn(),
  applyFleetControl: vi.fn(),
  takeFleetLeadership: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  fleetSlugFromName: (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-'),
  getFleet: (...a: unknown[]) => h.getFleet(...a),
}));
vi.mock('../coordination/presence', () => ({
  getPresence: (...a: unknown[]) => h.getPresence(...a),
}));
vi.mock('./control-core', () => ({
  applyFleetControl: (...a: unknown[]) => h.applyFleetControl(...a),
}));
vi.mock('./take-leadership-core', () => ({
  takeFleetLeadership: (...a: unknown[]) => h.takeFleetLeadership(...a),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => h.resolveAgentIdentity(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));

import supersedeTool from './supersede';

const CTX = { workspaceId: 'ws', role: 'operator' } as never;
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const invoke = (args: Record<string, unknown>) =>
  (supersedeTool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }> }).handler(
    args,
    CTX,
  );

function fleet(slug: string, over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: 'ws',
    fleetSlug: slug,
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    leaderMissingSinceMs: null,
    colorScheme: 'forest',
    controlState: 'active',
    fleetType: 'single',
    controlReason: null,
    controlBy: null,
    controlAt: null,
    controlResumeGate: null,
    controlExpiresAt: null,
    controlNoResumePath: false,
    lastLaunchTransaction: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-successor-leader', workspaceId: 'ws' });
  h.applyFleetControl.mockResolvedValue({ ok: true, fleet: 'old-fleet', controlState: 'winding-down' });
  h.takeFleetLeadership.mockResolvedValue({ leader: 'su-successor-leader', previousLeader: null, notified: false });
});

describe('fleet:supersede — WI-2034601 fix 2 (explicit predecessor standdown)', () => {
  it('refuses a fleet superseding itself', async () => {
    const out = parse(await invoke({ fleet: 'same', supersededBy: 'same' }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('self_supersede');
    expect(h.getFleet).not.toHaveBeenCalled();
  });

  it('refuses when the successor does not exist — never strands the predecessor with no continuation', async () => {
    h.getFleet.mockResolvedValueOnce(null); // successor lookup
    const out = parse(await invoke({ fleet: 'old-fleet', supersededBy: 'ghost-fleet' }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('successor_not_found');
    expect(h.applyFleetControl).not.toHaveBeenCalled();
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });

  it('refuses when the successor has no live leader', async () => {
    h.getFleet.mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-dead-leader' })); // successor
    h.getPresence.mockResolvedValueOnce(null); // successor leader presence miss
    const out = parse(await invoke({ fleet: 'old-fleet', supersededBy: 'new-fleet' }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('successor_leader_not_live');
    expect(h.applyFleetControl).not.toHaveBeenCalled();
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });

  it('refuses when the predecessor fleet does not exist', async () => {
    h.getFleet
      .mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-successor-leader' })) // successor
      .mockResolvedValueOnce(null); // predecessor
    h.getPresence.mockResolvedValueOnce({ ownerId: 'su-successor-leader' }); // successor leader live
    const out = parse(await invoke({ fleet: 'ghost-old', supersededBy: 'new-fleet' }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('fleet_not_found');
    expect(h.applyFleetControl).not.toHaveBeenCalled();
  });

  it('recovers leadership THEN terminally winds down when the predecessor leader is not live (the common case)', async () => {
    h.getFleet
      .mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-successor-leader' })) // successor
      .mockResolvedValueOnce(fleet('old-fleet', { leaderOwnerId: 'su-long-dead' })); // predecessor
    h.getPresence
      .mockResolvedValueOnce({ ownerId: 'su-successor-leader' }) // successor leader live
      .mockResolvedValueOnce(null); // predecessor leader NOT live

    const out = parse(await invoke({ fleet: 'old-fleet', supersededBy: 'new-fleet' }));

    expect(h.takeFleetLeadership).toHaveBeenCalledTimes(1);
    expect(h.takeFleetLeadership).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ fleetSlug: 'old-fleet' }),
      { ownerId: 'su-successor-leader', workspaceId: 'ws' },
      'su-successor-leader',
      {},
    );
    expect(h.applyFleetControl).toHaveBeenCalledTimes(1);
    const [, calledSlug, calledAction, calledReason, calledOpts] = h.applyFleetControl.mock.calls[0];
    expect(calledSlug).toBe('old-fleet');
    expect(calledAction).toBe('wind-down');
    expect(calledReason).toContain('new-fleet');
    expect(calledOpts).toEqual({ noResumePath: true });

    expect(out.ok).toBe(true);
    expect(out.tookLeadership).toBe(true);
    expect(out.predecessor).toBe('old-fleet');
    expect(out.supersededBy).toBe('new-fleet');
  });

  it('does NOT re-take leadership when the caller already leads the predecessor', async () => {
    h.getFleet
      .mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-successor-leader' })) // successor
      .mockResolvedValueOnce(fleet('old-fleet', { leaderOwnerId: 'su-successor-leader' })); // predecessor, already led by caller
    h.getPresence.mockResolvedValueOnce({ ownerId: 'su-successor-leader' }); // successor leader live

    const out = parse(await invoke({ fleet: 'old-fleet', supersededBy: 'new-fleet' }));

    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
    expect(h.applyFleetControl).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.tookLeadership).toBe(false);
  });

  it('honors an explicit reason instead of the auto-composed one', async () => {
    h.getFleet
      .mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-successor-leader' }))
      .mockResolvedValueOnce(fleet('old-fleet', { leaderOwnerId: 'su-successor-leader' }));
    h.getPresence.mockResolvedValueOnce({ ownerId: 'su-successor-leader' });

    await invoke({ fleet: 'old-fleet', supersededBy: 'new-fleet', reason: 'manual retire, custom note' });

    const [, , , calledReason] = h.applyFleetControl.mock.calls[0];
    expect(calledReason).toBe('manual retire, custom note');
  });

  it('propagates a failed wind-down (e.g. fleet_leader_mismatch) as the tool result', async () => {
    h.getFleet
      .mockResolvedValueOnce(fleet('new-fleet', { leaderOwnerId: 'su-successor-leader' }))
      .mockResolvedValueOnce(fleet('old-fleet', { leaderOwnerId: 'su-successor-leader' }));
    h.getPresence.mockResolvedValueOnce({ ownerId: 'su-successor-leader' });
    h.applyFleetControl.mockResolvedValueOnce({ ok: false, error: 'fleet_leader_mismatch', message: 'nope' });

    const out = parse(await invoke({ fleet: 'old-fleet', supersededBy: 'new-fleet' }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('fleet_leader_mismatch');
  });
});
