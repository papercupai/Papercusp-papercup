/**
 * scheduler:get_next — claim-time checkpoint hint (EI-529).
 *
 * scheduler:get_next is "the one every fleet member self-pulls through" (its own
 * doc comment) — the primary re-dispatch surface a dead/quiet holder's item flows
 * back through. Previously a fresh claimant got zero signal that a prior holder
 * had already left in-flight (possibly COMPLETE) progress, so it could silently
 * re-implement already-shipped work (the EI-529 pattern). Mirrors the EI-7252 fix
 * for work_items:get, surfaced at claim time instead of a separate lookup.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const scopeState = vi.hoisted(() => ({ scope: null as any, quarantinedIds: [] as string[], windingDown: false, pauseReason: null as string | null }));
const getNextM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
// WI-39730 bridged scheduler:get_next onto the per-Hive claim lease, so every claim now runs
// through leaseClaimedWorkItem — a REAL PG write the unit-test guard refuses. This file is about
// the claim-time checkpoint hint, not the lease, so the seam is stubbed with the lease DISABLED:
// `leaseOn === false` short-circuits arbitrateSchedulerClaim before either PG call, leaving the
// exact claim path these assertions were written against. get_next.test.ts owns the lease's own
// coverage (it drives the lease-lost release). BOTH exports must be supplied — get_next imports
// them together, so a factory missing one fails collection, not just the call.
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: () => false,
  leaseClaimedWorkItem: vi.fn(async () => true),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return { ...actual, getNextForBee: getNextM };
});
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: scopeState.scope, quarantinedIds: scopeState.quarantinedIds })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: scopeState.windingDown, reason: scopeState.pauseReason })),
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(async () => null),
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  fleetScopedMiss: () => ({ ok: false, error: 'scoped miss', windDown: true }),
}));
vi.mock('../../events/await/store', () => ({ cancelClaimableAwaits: vi.fn(async () => 0) }));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

import getNextTool from './get_next';

const run = async () => {
  const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
    data?: unknown;
    content?: Array<{ text: string }>;
  };
  // EI-20245892539908894: a successful claim returns `{ data }` (defineTool renders it into
  // BOTH structuredContent and text); a miss still returns the plain `{ content }` projection.
  // Unwrap either, so this helper asserts on the payload rather than on the envelope shape.
  return out.data ?? JSON.parse(out.content![0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeState.scope = null;
  scopeState.quarantinedIds = [];
  scopeState.windingDown = false;
  scopeState.pauseReason = null;
  getClaimTimeCheckpointHint.mockResolvedValue(null);
});

describe('scheduler:get_next — checkpoint hint at claim time (EI-529)', () => {
  it('attaches checkpoint + a loud warning when a prior holder left one', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-9', harness: 'papercup' }, claimedUnder: { specId: 's', revision: 1 } });
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'did: A; left: B', checkpointAgeMs: 9_000 });
    const b = await run();
    expect(getClaimTimeCheckpointHint).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-9', workspaceId: 'ws-1' });
    expect(b).toMatchObject({ ok: true, checkpoint: 'did: A; left: B', checkpointAgeMs: 9_000 });
    expect(b.checkpointWarning).toMatch(/PRIOR holder/);
    expect(b.checkpointWarning).toMatch(/EI-529/);
  });

  it('omits checkpoint fields entirely on a normal fresh claim (no prior checkpoint)', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-10', harness: 'papercup' }, claimedUnder: { specId: 's', revision: 1 } });
    getClaimTimeCheckpointHint.mockResolvedValue(null);
    const b = await run();
    expect(b).toMatchObject({ ok: true, workItem: { id: 'WI-10' } });
    expect(b.checkpoint).toBeUndefined();
    expect(b.checkpointWarning).toBeUndefined();
  });

  it('degrades to a normal claim (no crash) when the checkpoint lookup throws', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-11', harness: 'papercup' }, claimedUnder: { specId: 's', revision: 1 } });
    getClaimTimeCheckpointHint.mockRejectedValue(new Error('pg down'));
    const b = await run();
    expect(b).toMatchObject({ ok: true, workItem: { id: 'WI-11' } });
    expect(b.checkpoint).toBeUndefined();
  });

  it('never calls the checkpoint store on a miss (nothing claimed)', async () => {
    getNextM.mockResolvedValue(null);
    await run();
    expect(getClaimTimeCheckpointHint).not.toHaveBeenCalled();
  });
});
