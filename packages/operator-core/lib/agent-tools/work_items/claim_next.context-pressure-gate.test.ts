/**
 * WI-5940 — the context-pressure gate as WIRED INTO work_items:claim_next.
 *
 * context-pressure-claim-gate.test.ts already pins the DECISION exhaustively. This file exists
 * because a passing decision test proves nothing about the wiring: the property the filing
 * actually specifies is "**and no item is claimed**", which is a statement about what the handler
 * does NOT call. So every case here asserts against the claim seam (`getNextForBee` /
 * `claimNextWorkItem`), not merely against the returned text.
 *
 * The fail-open cases are asserted as hard as the refusal, for the reason recorded in the gate
 * module: the bucket is a ~2-min-stale cache, and a gate that over-refuses manufactures a false
 * drain — an agent idling while believing its lane is empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'su-me', workspaceId: 'ws-1' }));
const pressure = vi.hoisted(() => ({
  value: null as 'ok' | 'high' | 'critical' | null,
  estimatedAt: '2026-10-11T16:55:00.000Z',
  ageSec: 90,
  throws: false,
}));

vi.mock('../../events/await/store', () => ({ cancelClaimableAwaits: vi.fn(async () => 0) }));

vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    SCHEDULER_SPEC_CLAIM: 'scheduler.spec.claim',
    SCHEDULER_CONTEXT_PRESSURE_GATE: 'scheduler.context.pressure.gate',
  },
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));

// THE SEAM UNDER TEST. Mocked so the bucket is an input rather than whatever the live
// coord_presence row happens to say — the same reason the gate takes it as a parameter.
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressureReadings: vi.fn(async (ownerIds: string[]) => {
    if (pressure.throws) throw new Error('presence read failed');
    const m = new Map<string, { bucket: 'ok' | 'high' | 'critical'; estimatedAt: string; ageSec: number }>();
    if (pressure.value != null) {
      m.set(ownerIds[0]!, {
        bucket: pressure.value,
        estimatedAt: pressure.estimatedAt,
        ageSec: pressure.ageSec,
      });
    }
    return m;
  }),
  resolveContextPressureRecoveryPath: vi.fn(async () => null),
  // EI-23744538757758407: the refusal path now reads headroom alongside the recovery path, so a
  // factory omitting this throws "No export is defined on the mock" instead of exercising the
  // gate. null is a valid reading — the predicate treats unknown as "do not assert", which keeps
  // these WI-5940 cases asserting the ORIGINAL compaction wording.
  resolveContextPressureHeadroom: vi.fn(async () => null),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => identity,
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) =>
    value === 'self' ? callerOwnerId : value,
}));
// The directed target belongs to this private fixture roster. Keep the real
// context-pressure predicate independent of live coordination identities.
vi.mock('../coordination/recipient-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/recipient-resolve')>();
  return { ...actual, resolveExplicitAgentOwnerId: vi.fn<typeof actual.resolveExplicitAgentOwnerId>(async (raw, caller) => {
    const ownerId = raw === 'self' ? caller : raw;
    return ownerId === caller || ownerId === 'su-someone-else'
      ? { ok: true, ownerId }
      : { ok: false, code: 'assignee_unknown', message: 'Agent is absent from the fixture roster.' };
  }) };
});

vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(),
}));
vi.mock('../../work-item-redundancy', () => ({ workItemRedundancyEnabled: vi.fn(() => false) }));
vi.mock('../../fleet/swarm-identity', () => ({ localSwarmId: vi.fn(() => 'swarm-1') }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('./retraction-advisory', () => ({ getClaimTimeRetractionAdvisory: vi.fn(async () => null) }));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn((ws: string | null | undefined) => ws ?? undefined),
}));

vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: false, reason: null })),
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  fleetScopedMiss: () => ({ ok: false, error: 'scoped miss', windDown: true }),
}));

vi.mock('../../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items')>();
  return {
    CLAIM_STATES_ALLOWLIST: ['open', 'failing'],
    claimNextWorkItem: vi.fn(),
    releaseWorkItem: vi.fn(),
    diagnoseClaimNextMiss: vi.fn(),
    isSettledWorkItemState: actual.isSettledWorkItemState,
  };
});

import { getNextForBee } from '../../scheduler/claim-spec-store';
import { claimNextWorkItem, diagnoseClaimNextMiss } from '../../work-items';

const getNextForBeeM = vi.mocked(getNextForBee);
const claimNextM = vi.mocked(claimNextWorkItem);
const diagnoseM = vi.mocked(diagnoseClaimNextMiss);
const tool = (await import('./claim_next')).default;

async function call(args: Record<string, unknown>) {
  const out = (await tool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text);
}

/** Did the handler reach the claim path at all? This is the "no item is claimed" oracle. */
function claimWasAttempted(): boolean {
  return getNextForBeeM.mock.calls.length > 0 || claimNextM.mock.calls.length > 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'su-me';
  identity.workspaceId = 'ws-1';
  pressure.value = null;
  pressure.estimatedAt = '2026-10-11T16:55:00.000Z';
  pressure.ageSec = 90;
  pressure.throws = false;
  getNextForBeeM.mockResolvedValue(null);
  // The serve-path cases deliberately end in a MISS (getNextForBee -> null): what they assert is
  // that the claim path was REACHED, not that an item came back. missResult() reads this
  // diagnosis, so it needs a real shape or the miss renderer throws before the assertion runs.
  diagnoseM.mockResolvedValue({
    drained: true,
    pendingUnclaimed: 0,
    readyUnclaimed: 0,
    flagReadError: null,
  });
});

describe('work_items:claim_next context-pressure gate (WI-5940)', () => {
  it('at CRITICAL: returns the typed refusal AND never reaches the claim path', async () => {
    pressure.value = 'critical';
    const res = await call({ harness: 'papercusp' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('claim_refused_context_critical');
    expect(res.error).toMatch(/compact/i);
    expect(res.diagnosis).toMatchObject({
      contextEstimate: { estimatedAt: pressure.estimatedAt, ageSec: pressure.ageSec },
    });
    // The acceptance criterion, asserted as a fact about the seam rather than the prose.
    expect(claimWasAttempted()).toBe(false);
  });

  it("at 'ok' and 'high': unchanged — the claim path is reached", async () => {
    for (const bucket of ['ok', 'high'] as const) {
      vi.clearAllMocks();
      getNextForBeeM.mockResolvedValue(null);
      pressure.value = bucket;
      await call({ harness: 'papercusp' });
      expect(claimWasAttempted()).toBe(true);
    }
  });

  it('on an UNKNOWN bucket: serves — a missing/stale reading never withholds work', async () => {
    pressure.value = null; // owner absent from the map, exactly as fetchContextPressure omits stale
    await call({ harness: 'papercusp' });
    expect(claimWasAttempted()).toBe(true);
  });

  it('FAILS OPEN when the presence read throws — a broken read is not a refusal', async () => {
    pressure.throws = true;
    const res = await call({ harness: 'papercusp' });
    expect(res.code).not.toBe('claim_refused_context_critical');
    expect(claimWasAttempted()).toBe(true);
  });

  it('honors ignoreContextPressure at critical (the live gauge beats the cached bucket)', async () => {
    pressure.value = 'critical';
    await call({ harness: 'papercusp', ignoreContextPressure: true });
    expect(claimWasAttempted()).toBe(true);
  });

  it('does NOT gate a DIRECTED claim for another agent, even at critical', async () => {
    // A named assignee is a leader placing work on someone else. Gating that on the CALLER's
    // pressure would refuse based on the wrong agent's state — see the scope note in the module.
    pressure.value = 'critical';
    await call({ harness: 'papercusp', assignee: 'su-someone-else' });
    expect(claimWasAttempted()).toBe(true);
  });

  it("DOES gate assignee:'self', which resolves to the caller", async () => {
    pressure.value = 'critical';
    const res = await call({ harness: 'papercusp', assignee: 'self' });
    expect(res.code).toBe('claim_refused_context_critical');
    expect(claimWasAttempted()).toBe(false);
  });
});
