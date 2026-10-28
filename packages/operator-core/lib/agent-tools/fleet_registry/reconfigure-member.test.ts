/**
 * Unit tests for fleet:reconfigure-member (P-007). The store / presence / message seams are
 * mocked; the REAL validateClaimSpec (pure) runs. Covers fleet resolution (default-led vs
 * explicit), leader/queen/owner auth, member resolution, and per-lever application
 * (compactionLimit → P-006 setter, claimSpec → set store, brief → coord message).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFleet = vi.fn();
const listFleetsLedBy = vi.fn();
const getPresence = vi.fn();
const fetchPresenceFleet = vi.fn();
const sendMessage = vi.fn();
const setClaimSpec = vi.fn();
const setCompactionLimitForOwner = vi.fn();
const classifyAgentPane = vi.fn();
const listFleetMembers = vi.fn();

const LEADER = 'su-leader';
const MEMBER = 'su-member-abc';
const WS = 'ws';
const SLUG = 'rocket';

// Partial-mock agent-mcp: keep real defineTool/SU_ROLES, control classifyAgentPane.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  classifyAgentPane: (...a: unknown[]) => classifyAgentPane(...a),
}));
vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...a: unknown[]) => getFleet(...a),
  listFleetsLedBy: (...a: unknown[]) => listFleetsLedBy(...a),
  fleetSlugFromName: (s: string) => s.trim().toLowerCase(),
}));
vi.mock('../coordination/presence', () => ({ getPresence: (...a: unknown[]) => getPresence(...a) }));
vi.mock('../coordination/presence-fleet', () => ({ fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a) }));
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetMembers: (...a: unknown[]) => listFleetMembers(...a) },
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  setClaimSpec: (...a: unknown[]) => setClaimSpec(...a),
  resolveClaimSpecWorkspace: (ws: string) => ws,
}));
vi.mock('../config/set-compaction-limit-core', () => ({
  setCompactionLimitForOwner: (...a: unknown[]) => setCompactionLimitForOwner(...a),
}));
vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'ladder',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
  resolveFleetCaller: () => ({ identity: { ownerId: LEADER }, ownerId: LEADER, workspaceId: WS }),
}));

import tool from './reconfigure-member';

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}
const validSpec = {
  specVersion: '1.0',
  specId: 'lane-1',
  revision: 1,
  view: { filter: { all: [{ field: 'kind', op: 'in', value: ['bug'] }] } },
  rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'asc' }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  getFleet.mockResolvedValue({ fleetSlug: SLUG, leaderOwnerId: LEADER });
  listFleetsLedBy.mockResolvedValue([{ fleetSlug: SLUG, leaderOwnerId: LEADER }]);
  getPresence.mockResolvedValue({ agentRole: 'su' });
  classifyAgentPane.mockReturnValue({ kind: 'su' });
  fetchPresenceFleet.mockResolvedValue(new Map([[MEMBER, { fleetSlug: SLUG, fleetRole: 'member' }]]));
  setCompactionLimitForOwner.mockResolvedValue({ ok: true, compactionLimit: 200_000, invokedAs: 'leader' });
  // Mirror the REAL setClaimSpec success return ({ ok:true, errors:[], revision }): the handler
  // spreads it verbatim (never forces ok:true, so a store-reported ok:false is not masked).
  setClaimSpec.mockResolvedValue({ ok: true, errors: [], revision: 3 });
  sendMessage.mockResolvedValue({ msg_id: 'm1' });
  listFleetMembers.mockResolvedValue([MEMBER]);
});

describe('fleet:reconfigure-member (P-007)', () => {
  it('applies all three levers to a member of the default led fleet', async () => {
    const res = await tool.handler(
      { member: MEMBER, compactionLimit: 200_000, claimSpec: validSpec, brief: 'focus on the CDC bugs' } as never,
      {} as never,
    );
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, fleet: SLUG, member: MEMBER, invokedAs: 'leader' });
    expect(setCompactionLimitForOwner).toHaveBeenCalledWith(expect.anything(), MEMBER, 200_000, { directiveRef: undefined });
    expect(setClaimSpec).toHaveBeenCalledWith(expect.objectContaining({ cupId: MEMBER, spec: validSpec, updatedBy: LEADER }));
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: [MEMBER] }));
    expect(p.applied.compactionLimit.ok).toBe(true);
    expect(p.applied.claimSpec).toMatchObject({ ok: true, revision: 3 });
    expect(p.applied.brief).toMatchObject({ ok: true, msgId: 'm1' });
  });

  it('forwards directiveRef to the cross-session setter so an owner directive can lift the role cap (WI-6554700010042435)', async () => {
    setCompactionLimitForOwner.mockResolvedValueOnce({
      ok: true,
      compactionLimit: 825_000,
      invokedAs: 'leader',
      ownerDirective: { id: 2560, excerpt: 'increase your papercusp context limit to the maximum' },
    });
    const res = await tool.handler({ member: MEMBER, compactionLimit: 825_000, directiveRef: 2560 } as never, {} as never);
    const p = parse(res);
    expect(setCompactionLimitForOwner).toHaveBeenCalledWith(expect.anything(), MEMBER, 825_000, { directiveRef: 2560 });
    expect(p.ok).toBe(true);
    expect(p.applied.compactionLimit).toMatchObject({ ok: true, compactionLimit: 825_000, ownerDirective: { id: 2560 } });
  });

  it('rejects an invalid claim spec per-lever (overall ok:false), without touching the store', async () => {
    const res = await tool.handler({ member: MEMBER, claimSpec: { bogus: true } } as never, {} as never);
    const p = parse(res);
    expect(p.ok).toBe(false);
    expect(p.applied.claimSpec.ok).toBe(false);
    expect(setClaimSpec).not.toHaveBeenCalled();
  });

  it('propagates a compaction-limit cap refusal as an overall failure', async () => {
    setCompactionLimitForOwner.mockResolvedValueOnce({
      ok: false,
      error: 'limit_exceeds_cap',
      requested: 500_000,
      cap: 200_000,
    });
    const res = await tool.handler({ member: MEMBER, compactionLimit: 500_000 } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, fleet: SLUG, member: MEMBER, invokedAs: 'leader' });
    expect(p.applied.compactionLimit).toMatchObject({ ok: false, error: 'limit_exceeds_cap', cap: 200_000 });
  });

  it('refuses a caller who is neither the fleet leader nor a queen/owner pane', async () => {
    getFleet.mockResolvedValue({ fleetSlug: SLUG, leaderOwnerId: 'su-someone-else' });
    listFleetsLedBy.mockResolvedValue([]); // not leading; must pass explicit fleet
    classifyAgentPane.mockReturnValue({ kind: 'cup' });
    const res = await tool.handler({ member: MEMBER, fleet: SLUG, brief: 'hi' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a member that is not in the fleet', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map()); // target carries no fleet label
    listFleetMembers.mockResolvedValue(['su-other-1', 'su-other-2']); // no prefix match
    const res = await tool.handler({ member: 'su-ghost', brief: 'hi' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'member_not_found', fleet: SLUG });
  });

  it('errors when the caller leads no fleet and passes no explicit fleet', async () => {
    listFleetsLedBy.mockResolvedValue([]);
    const res = await tool.handler({ member: MEMBER, brief: 'hi' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'no_led_fleet' });
  });

  it('rejects an empty reconfigure (no lever passed)', async () => {
    const res = await tool.handler({ member: MEMBER } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'nothing_to_do' });
  });

  it('resolves a member by unique prefix', async () => {
    fetchPresenceFleet.mockImplementation(async (ids: string[]) =>
      ids[0] === 'su-mem' ? new Map() : new Map([[MEMBER, { fleetSlug: SLUG, fleetRole: 'member' }]]),
    );
    listFleetMembers.mockResolvedValue([MEMBER]);
    const res = await tool.handler({ member: 'su-mem', brief: 'hi' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, member: MEMBER });
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: [MEMBER] }));
  });
});
