import { describe, it, expect, beforeEach, vi } from 'vitest';
import revertTool from './tripwire_revert';
import { getTripwire, markTripwireTripped, markTripwireReverted } from '../../autonomy/tripwire/store';
import { getAutonomyCategoryPolicy, setAutonomyPolicy } from '../../autonomy/policy-store';
import { demoteGraduatedLevel } from '../../autonomy/tripwire/core';
import { notifySyncInvalidate } from '../../sync-sse';
import { activeWorkspaceId } from '../../workspace-registry';
import { executeRevertVia } from '../../autonomy/tripwire/revert-executor';

// PG-free unit: the tripwire store + core have their own suites; this pins the
// TOOL's owner-undo control flow — not_found / already_resolved guards, the
// demote-one-step decision (locked / pinned / no-change skips vs a real demote),
// and the trip + sync-invalidate side effects (B-16 / P-081, D-005).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/tripwire/store', () => ({
  getTripwire: vi.fn(),
  markTripwireTripped: vi.fn(),
  markTripwireReverted: vi.fn(),
}));
vi.mock('../../autonomy/policy-store', () => ({
  getAutonomyCategoryPolicy: vi.fn(),
  setAutonomyPolicy: vi.fn(),
}));
// Partial mock: the tool's import graph also reads core's real constants
// (e.g. DEFAULT_TRIPWIRE_WINDOW_HOURS via attention/bulk-run-store), so a
// whole-module factory fails collection. Only the demote decision is stubbed.
vi.mock('../../autonomy/tripwire/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../autonomy/tripwire/core')>()),
  demoteGraduatedLevel: vi.fn(),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('../../autonomy/tripwire/revert-executor', () => ({
  executeRevertVia: vi.fn(),
  makeRevertRegistry: vi.fn(() => new Map()),
  defaultRevertHelpers: vi.fn(() => ({})),
}));

const mockGet = vi.mocked(getTripwire);
const mockTripped = vi.mocked(markTripwireTripped);
const mockReverted = vi.mocked(markTripwireReverted);
const mockGetPolicy = vi.mocked(getAutonomyCategoryPolicy);
const mockSetPolicy = vi.mocked(setAutonomyPolicy);
const mockDemote = vi.mocked(demoteGraduatedLevel);
const mockInvalidate = vi.mocked(notifySyncInvalidate);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockExecuteRevert = vi.mocked(executeRevertVia);

function tripwire(p: Record<string, unknown> = {}) {
  return {
    id: 'tw-1',
    category: 'docs-publish',
    status: 'armed',
    revertHandle: { kind: 'flag', ref: 'x' },
    ...p,
  } as unknown as Awaited<ReturnType<typeof getTripwire>>;
}
function policy(p: Record<string, unknown> = {}) {
  return {
    category: 'docs-publish',
    graduatedLevel: 'medium',
    locked: false,
    ownerOverride: null,
    ...p,
  } as unknown as Awaited<ReturnType<typeof getAutonomyCategoryPolicy>>;
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    revertTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:tripwire_revert tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockGet.mockResolvedValue(tripwire());
    mockGetPolicy.mockResolvedValue(policy());
    mockDemote.mockReturnValue('low' as ReturnType<typeof demoteGraduatedLevel>);
    mockSetPolicy.mockResolvedValue(policy({ graduatedLevel: 'low' }));
    mockTripped.mockResolvedValue(undefined as never);
    mockReverted.mockResolvedValue(undefined as never);
    mockInvalidate.mockResolvedValue(undefined as never);
    mockExecuteRevert.mockResolvedValue({ reverted: true, note: 'restored source action' });
  });

  it('returns not_found (isError) when the tripwire does not exist — no side effects', async () => {
    mockGet.mockResolvedValue(null as never);
    const res = await callTool({ tripwireId: 'nope' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(mockTripped).not.toHaveBeenCalled();
    expect(mockSetPolicy).not.toHaveBeenCalled();
  });

  it('returns already_resolved (isError) for a non-armed tripwire', async () => {
    mockGet.mockResolvedValue(tripwire({ status: 'reverted' }));
    const res = await callTool({ tripwireId: 'tw-1' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: false,
      reason: 'already_resolved',
      status: 'reverted',
    });
    expect(mockTripped).not.toHaveBeenCalled();
  });

  it('trips owner-thumbs-down + demotes one step + fires sync-invalidate on the happy path', async () => {
    const res = await callTool(
      { tripwireId: 'tw-1', reason: 'too aggressive' },
      { principal: { workspaceId: 'ws-prin', slug: 'owner-sue' } },
    );
    expect(mockTripped).toHaveBeenCalledWith(
      expect.anything(),
      'ws-prin',
      'tw-1',
      'owner-thumbs-down',
      expect.any(Number),
      'owner-sue',
    );
    expect(mockSetPolicy).toHaveBeenCalledWith(
      expect.anything(),
      'ws-prin',
      expect.objectContaining({ category: 'docs-publish', graduatedLevel: 'low', reason: 'too aggressive' }),
      'owner-sue',
    );
    // Name-only invalidation (no args) so the settings table's no-arg subscription
    // actually refetches — an args-scoped invalidate never matches its query key.
    expect(mockInvalidate).toHaveBeenCalledWith('autonomy.policy');
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({
      ok: true,
      tripped: true,
      demoted: true,
      demotion: { from: 'medium', to: 'low' },
      reverted: true,
      note: 'restored source action',
    });
    expect(mockReverted).toHaveBeenCalledWith(expect.anything(), 'ws-prin', 'tw-1', expect.any(Number));
  });

  it('skips the demotion (still trips) when the category is locked', async () => {
    mockGetPolicy.mockResolvedValue(policy({ locked: true }));
    const res = await callTool({ tripwireId: 'tw-1' });
    const body = JSON.parse(res.content[0].text);
    expect(mockTripped).toHaveBeenCalled();
    expect(mockSetPolicy).not.toHaveBeenCalled();
    expect(body).toMatchObject({ demoted: false, demotion: { skipped: 'locked' } });
  });

  it('skips the demotion when the category is owner-pinned', async () => {
    mockGetPolicy.mockResolvedValue(policy({ ownerOverride: { pinned: true } }));
    const res = await callTool({ tripwireId: 'tw-1' });
    expect(mockSetPolicy).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ demoted: false, demotion: { skipped: 'pinned' } });
  });

  it('skips the demotion when already at the floor (demote is a no-op)', async () => {
    mockDemote.mockReturnValue('medium' as ReturnType<typeof demoteGraduatedLevel>); // to === from
    const res = await callTool({ tripwireId: 'tw-1' });
    expect(mockSetPolicy).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ demoted: false, demotion: { skipped: 'no-change' } });
  });
});
