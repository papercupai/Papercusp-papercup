/**
 * Unit tests for `setCompactionLimitForOwner` — the P-006 cross-session compaction-limit
 * setter (per-member-declarative-launch-specs). Presence / fleet-store / model-spec seams are
 * mocked; the REAL `classifyFleetControlInvoker` (pure) and REAL `agent-config-constants`
 * (clamp / role-cap) run, so leader/queen/owner authorization AND the target-role-derived
 * ceiling (the 250k fleet-member cap vs the 825k self-set ceiling a leader/solo target
 * gets on [1m]) are exercised for real. Runtime requests above those ceilings are
 * rejected before the write rather than silently persisted at a different value.
 *
 * NOTE (2026-08-08): this verb is the DELIBERATE self-set path, so it validates against
 * `selfSetCeilingForSpec` (825k on [1m]) rather than the SEEDED default
 * (`COMPACTION_LIMIT_DEFAULT_1M_CAP`, 400k) — those were one constant until 2026-08-08,
 * which made "raise it for wide-context work" unreachable. Fleet MEMBERS are deliberately
 * unchanged at the role cap, so a member cannot self-raise past the cap its leader governs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP } from '../../agent-config-constants';
import type { OwnerForceDirectiveRow } from '../work_items/release-force-guard';

const getFleet = vi.fn();
const setCompactionLimit = vi.fn();
const getPresence = vi.fn();
const fetchPresenceFleet = vi.fn();
const resolveModelSpecForOwner = vi.fn();
const estimateContextWindowForOwner = vi.fn();
const classifyAgentPane = vi.fn();

const CALLER = 'su-caller';
const WS = 'ws';

/**
 * The self-set ceiling for a `[1m]` leader/solo target: `floor((1M − 10k) / 1.2)`.
 * Pinned as a LITERAL on purpose — deriving it from `selfSetCeilingForSpec` here would
 * make these assertions tautological (they would pass even if the helper were wrong).
 * Mirrors how `agent-config-constants.test.ts` pins the same number.
 */
const SELF_SET_1M_CEILING = 825_000;

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  classifyAgentPane: (...a: unknown[]) => classifyAgentPane(...a),
}));
vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...a: unknown[]) => getFleet(...a),
}));
vi.mock('../coordination/presence', () => ({
  setCompactionLimit: (...a: unknown[]) => setCompactionLimit(...a),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a),
}));
vi.mock('../../compaction-usage', () => ({
  resolveModelSpecForOwner: (...a: unknown[]) => resolveModelSpecForOwner(...a),
  estimateContextWindowForOwner: (...a: unknown[]) => estimateContextWindowForOwner(...a),
}));
vi.mock('../fleet_registry/_shared', () => ({
  resolveFleetCaller: () => ({
    identity: { ownerId: CALLER, workspaceId: WS },
    ownerId: CALLER,
    workspaceId: WS,
  }),
}));

import { setCompactionLimitForOwner } from './set-compaction-limit-core';

/** target presence-fleet map helper */
function fleetMap(target: string, fleetSlug: string | null, fleetRole: string | null) {
  return new Map(fleetSlug ? [[target, { fleetSlug, fleetRole }]] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveModelSpecForOwner.mockResolvedValue('opus[1m]'); // 400k leader / 300k member gap
  estimateContextWindowForOwner.mockResolvedValue(null);
  classifyAgentPane.mockReturnValue({ kind: 'su' }); // default: owner-grade pane
  getPresence.mockResolvedValue({ agentRole: 'su', compactionLimit: null });
});

describe('setCompactionLimitForOwner (P-006 cross-session limit setter)', () => {
  it('a fleet leader rejects a MEMBER limit above the member ceiling without writing a clamp', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: CALLER }); // caller IS this fleet's leader
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-mem' ? { compactionLimit: COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP } : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 500_000);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: false,
      invokedAs: 'leader',
      targetOwnerId: 'su-mem',
      cap: COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
      requested: 500_000,
      error: 'limit_exceeds_cap',
      fleet: 'rocket',
      targetRole: 'member',
    });
  });

  it('the queen (mug/kettle pane) may set a member limit even when not its leader', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });
    classifyAgentPane.mockReturnValue({ kind: 'mug' }); // queen
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-mem' ? { compactionLimit: 150_000 } : { agentRole: 'mug' },
    );
    // 150k is below the fleet-member cap → applied verbatim, not clamped.
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 150_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-mem', 150_000, { explicit: true }); // within cap → verbatim
    expect(out).toMatchObject({ ok: true, invokedAs: 'queen', compactionLimit: 150_000 });
    expect(out.clamped).toBeUndefined();
  });

  describe('owner-directive role-cap lift (WI-6554700010042435)', () => {
    const NOW = 1_800_000_000_000;
    function directive(over: Partial<OwnerForceDirectiveRow> = {}): OwnerForceDirectiveRow {
      return {
        id: 2560,
        workspaceId: WS,
        recordedBy: 'su-mem',
        verbatimText: 'increase your papercusp context limit to the maximum',
        createdAtMs: NOW - 60_000,
        dispositionedAtMs: null,
        capturedByHook: true,
        ...over,
      };
    }
    /** `persisted` is what the post-write presence re-read returns (the setter reports it back). */
    function asMemberOfCallersFleet(persisted: number = COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) {
      fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
      getFleet.mockResolvedValue({ leaderOwnerId: CALLER });
      getPresence.mockImplementation(async (id: string) =>
        id === 'su-mem' ? { compactionLimit: persisted } : { agentRole: 'su' },
      );
    }

    it('a member with NO directiveRef is still refused above the role cap', async () => {
      asMemberOfCallersFleet();
      const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', SELF_SET_1M_CEILING);
      expect(setCompactionLimit).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: false, error: 'limit_exceeds_cap', cap: COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP });
    });

    it('a VERIFIED owner directive addressed to the member lifts the cap to the window ceiling', async () => {
      asMemberOfCallersFleet(SELF_SET_1M_CEILING);
      const getDirective = vi.fn(async () => directive());
      const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', SELF_SET_1M_CEILING, {
        directiveRef: 2560,
        directiveDeps: { getDirective, now: () => NOW },
      });
      expect(getDirective).toHaveBeenCalledWith(2560);
      expect(setCompactionLimit).toHaveBeenCalledWith('su-mem', SELF_SET_1M_CEILING, { explicit: true });
      expect(out).toMatchObject({ ok: true, compactionLimit: SELF_SET_1M_CEILING, ownerDirective: { id: 2560 } });
    });

    it('a verified directive addressed to the CALLER (the leader executing it) also lifts the cap', async () => {
      asMemberOfCallersFleet(SELF_SET_1M_CEILING);
      const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', SELF_SET_1M_CEILING, {
        directiveRef: 2560,
        directiveDeps: { getDirective: async () => directive({ recordedBy: CALLER }), now: () => NOW },
      });
      expect(out).toMatchObject({ ok: true, compactionLimit: SELF_SET_1M_CEILING, ownerDirective: { id: 2560 } });
    });

    it('the window ceiling still binds under a verified directive: 900k is rejected without a write', async () => {
      asMemberOfCallersFleet();
      const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 900_000, {
        directiveRef: 2560,
        directiveDeps: { getDirective: async () => directive(), now: () => NOW },
      });
      expect(setCompactionLimit).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: false, error: 'limit_exceeds_cap', cap: SELF_SET_1M_CEILING });
    });

    it.each([
      ['agent-recorded (orders:record)', { capturedByHook: false }],
      ['already dispositioned', { dispositionedAtMs: NOW - 1_000 }],
      ['addressed to a third session', { recordedBy: 'su-unrelated' }],
      ['from another workspace', { workspaceId: 'ws-other' }],
    ])('an %s directive is refused as directive_unverified with no write', async (_label, over) => {
      asMemberOfCallersFleet();
      const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', SELF_SET_1M_CEILING, {
        directiveRef: 2560,
        directiveDeps: { getDirective: async () => directive(over as Partial<OwnerForceDirectiveRow>), now: () => NOW },
      });
      expect(setCompactionLimit).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: false, error: 'directive_unverified', requested: SELF_SET_1M_CEILING });
    });
  });

  it('refuses a caller who is neither the leader nor a queen/owner pane', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });
    classifyAgentPane.mockReturnValue({ kind: 'cup' }); // not leader, not su/mug/kettle
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 250_000);
    expect(out).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(setCompactionLimit).not.toHaveBeenCalled();
  });

  it('a LEADER target may exceed the 400k seeded default — 500k applies verbatim', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-lead2', 'other', 'leader'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-lead2' }); // target leads; caller is owner (su)
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-lead2' ? { compactionLimit: 500_000 } : { agentRole: 'su' },
    );
    // 500k is above the SEEDED 400k default but inside the 825k self-set ceiling. This
    // silently clamped back to 400k until 2026-08-08 — the exact defect the split fixed.
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-lead2', 500_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-lead2', 500_000, { explicit: true });
    expect(out).toMatchObject({
      ok: true,
      invokedAs: 'owner',
      cap: SELF_SET_1M_CEILING, // the leader/solo ceiling, not the 250k member cap
      targetRole: 'leader',
    });
    expect(out.clamped).toBeUndefined();
  });

  it('the 825k self-set ceiling is still a REAL bound for a leader target: 900k is rejected without a write', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-lead2', 'other', 'leader'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-lead2' });
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-lead2' ? { compactionLimit: SELF_SET_1M_CEILING } : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-lead2', 900_000);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: false,
      cap: SELF_SET_1M_CEILING,
      targetRole: 'leader',
      requested: 900_000,
      error: 'limit_exceeds_cap',
    });
  });

  it('uses a narrower measured effective window for a leader target', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-lead2', 'other', 'leader'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-lead2' });
    estimateContextWindowForOwner.mockResolvedValue(828_400);
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-lead2' ? { compactionLimit: null } : { agentRole: 'su' },
    );

    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-lead2', 800_000);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: false,
      cap: 682_000,
      requested: 800_000,
      error: 'limit_exceeds_cap',
      targetRole: 'leader',
    });
  });

  it('reports ok:false + a note when the target has no live presence row to persist onto', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-gone', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: CALLER });
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-gone' ? null : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-gone', 150_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-gone', 150_000, { explicit: true });
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/no live presence row/);
  });
});
