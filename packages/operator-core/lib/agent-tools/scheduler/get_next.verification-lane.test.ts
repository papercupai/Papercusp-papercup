/**
 * P-007 Phase B (D-027): when a verifier-lane claim spec served the pull, scheduler:get_next's
 * success payload names the lane, the kind of verification work served, and the next call to
 * make. An ordinary (implementation) pull carries no `verification` block.
 *
 * getNextForBee is mocked at the module boundary, as in get_next.warning.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(),
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(async () => true),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: mocks.getFlag,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: mocks.getNextForBee,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: mocks.workItemClaimLeaseEnabled,
  leaseClaimedWorkItem: mocks.leaseClaimedWorkItem,
}));
vi.mock('../../work-scope-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-scope-policy')>()),
  gateWorkScope: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../coordination/context-pressure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/context-pressure')>()),
  fetchContextPressure: vi.fn(async () => new Map()),
  resolveContextPressureRecoveryPath: vi.fn(async () => null),
}));
vi.mock('../locks/live-lock-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/live-lock-paths')>()),
  liveLockedPaths: vi.fn(async () => []),
}));
vi.mock('../../scheduler/fleet-scope-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/fleet-scope-admission')>()),
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => undefined),
}));

import getNextTool from './get_next';

type ToolDef = {
  handler: (args: unknown, ctx?: unknown) => Promise<{
    content?: Array<{ text: string }>;
    data?: Record<string, unknown>;
  }>;
};

async function callGetNext(args: Record<string, unknown> = { harness: 'papercusp' }) {
  const res = await (getNextTool as unknown as ToolDef).handler(args, {});
  return (res.data ?? JSON.parse(res.content![0].text)) as Record<string, unknown>;
}

function served(id: string, verificationKind?: 'agent-review' | 'verification-task') {
  return {
    workItem: { id, state: 'open' },
    claimedUnder: { specId: 'verifier-lane', revision: 2 },
    specSource: 'fleet',
    ...(verificationKind ? { verificationKind } : {}),
  };
}

describe('scheduler:get_next verifier-lane marker (P-007 Phase B / D-027)', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-verifier', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
  });

  it('a served agent review names the lane, the kind, and the grading call', async () => {
    mocks.getNextForBee.mockResolvedValue(served('EI-REVIEW', 'agent-review'));

    const out = await callGetNext();

    expect(out.ok, JSON.stringify(out)).toBe(true);
    const verification = out.verification as Record<string, string>;
    expect(verification.lane).toBe('verification');
    expect(verification.kind).toBe('agent-review');
    expect(verification.next).toContain('blender:grade-idea');
  });

  it('a served verification task names its check and subject as the next step', async () => {
    mocks.getNextForBee.mockResolvedValue(served('WI-TASK', 'verification-task'));

    const out = await callGetNext();

    expect(out.ok, JSON.stringify(out)).toBe(true);
    const verification = out.verification as Record<string, string>;
    expect(verification.lane).toBe('verification');
    expect(verification.kind).toBe('verification-task');
    expect(verification.next).toContain('payload.verification.check');
    expect(verification.next).toContain('payload.verification.subject');
  });

  it('an ordinary implementation pull carries no verification block', async () => {
    mocks.getNextForBee.mockResolvedValue(served('WI-IMPL'));

    const out = await callGetNext();

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.verification).toBeUndefined();
  });
});
