/**
 * EI-11110 / WI-5976: unit tests for `syncLaunchModeToRegistry`.
 *
 * Root cause: a fleet/auto launch used to bake "AUTO mode is ON" (and the
 * watermarked instructionPrecedence snapshot) into the session PROSE ONLY —
 * computed from the launch request's local autoMode/drainMode booleans — and
 * NEVER wrote the actual mode registry (harness_shared.agent_modes) that
 * mode:set / coord:orient read live. A fresh session's first prompt asserted
 * AUTO was on while the very next coord:orient call (reading the real
 * registry) reported no active modes and 'confirm-before-execution' — a live
 * text-vs-registry contradiction, reproduced first-hand while investigating
 * this ticket (EI-11110's own claiming session hit exactly this).
 *
 * These tests pin `syncLaunchModeToRegistry`'s wiring at the store seam
 * (mocked — no PG): it must call setMode with the right modeId(s) for
 * auto-only vs drain (which stacks 'auto'+'drain', different axes), skip
 * entirely when autoMode is false, refresh the control anchor projection on
 * success, and surface (never throw) a message on failure — mirroring
 * stampFleetMembershipAtBoot's contract (bootstrap-su-fleet-stamp.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SetModeResult } from '../../../modes/store';

// Explicit SetModeResult return type: the bare literal `{ ok: true, noop: false }`
// made TS infer this mock's resolved-value type as exactly `{ok, noop}`, so later
// mockResolvedValueOnce calls carrying stickyConflict/error (real SetModeResult
// fields) failed as excess properties (TS2353).
const setModeMock = vi.fn(async (_opts: unknown): Promise<SetModeResult> => ({ ok: true, noop: false }));
const refreshControlAnchorMock = vi.fn(async (_opts: unknown) => ({}));
const assertFactMock = vi.fn(async (_opts: unknown) => ({}));
const retractFactMock = vi.fn(async (_opts: unknown) => true);

vi.mock('../../../modes/store', () => ({
  setMode: (opts: unknown) => setModeMock(opts),
}));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: (opts: unknown) => refreshControlAnchorMock(opts),
}));
vi.mock('../../../agent-facts/store', async (orig) => ({
  ...(await orig<typeof import('../../../agent-facts/store')>()),
  assertFact: (opts: unknown) => assertFactMock(opts),
  retractFact: (opts: unknown) => retractFactMock(opts),
}));
vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()),
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-tools/coordination/presence')>()),
  touchHeartbeat: vi.fn(async () => {}),
}));

import { normalizeBootstrapLaunchMode, syncLaunchModeToRegistry } from './bootstrap-su';

beforeEach(() => {
  setModeMock.mockClear();
  refreshControlAnchorMock.mockClear();
  assertFactMock.mockClear();
  retractFactMock.mockClear();
  setModeMock.mockResolvedValue({ ok: true, noop: false });
  refreshControlAnchorMock.mockResolvedValue({});
});

describe('syncLaunchModeToRegistry (EI-11110 / WI-5976)', () => {
  it('uses the same member-role normalization for first-turn prose and durable scope', () => {
    const inherited = { mode: 'drain', subject: 'bugs', instructions: 'Lead this fleet', ownerDirected: true };
    const member = normalizeBootstrapLaunchMode(inherited, { slug: 'bugs', role: 'member' });
    expect(member?.ownerDirected).toBe(false);
    expect(member?.instructions).toContain('Do not take leadership');
    expect(member?.instructions).not.toContain('Lead this fleet');
    expect(normalizeBootstrapLaunchMode(inherited, { slug: 'bugs', role: 'leader' })).toEqual(inherited);
    expect(normalizeBootstrapLaunchMode(inherited)).toEqual(inherited);
  });

  it('no-ops (never touches the registry) when autoMode is false', async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-abc',
      autoMode: false,
      drainMode: false,
      reason: 'irrelevant',
    });
    expect(err).toBeNull();
    expect(setModeMock).not.toHaveBeenCalled();
    expect(refreshControlAnchorMock).not.toHaveBeenCalled();
  });

  it('registers exactly \'auto\' for a plain --auto launch, then refreshes the control anchor', async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      autoMode: true,
      drainMode: false,
      reason: 'fleet launch: --auto',
    });
    expect(err).toBeNull();
    expect(setModeMock).toHaveBeenCalledTimes(1);
    expect(setModeMock).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      modeId: 'auto',
      enabled: true,
      reason: 'fleet launch: --auto',
      setBy: 'su-abc',
    });
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
    expect(refreshControlAnchorMock).toHaveBeenCalledWith({
      ownerId: 'su-abc',
      workspaceId: 'papercusp-workspace',
      origin: 'system',
      actorId: 'su-abc',
      source: 'mode:set',
    });
  });

  it("registers BOTH 'auto' and 'drain' for a --mode=drain launch (DRAIN implies AUTO, different axes)", async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: true,
      reason: 'fleet launch: --mode=drain (DRAIN implies AUTO)',
    });
    expect(err).toBeNull();
    expect(setModeMock).toHaveBeenCalledTimes(2);
    expect(setModeMock.mock.calls.map((c) => (c[0] as { modeId: string }).modeId)).toEqual([
      'auto',
      'drain',
    ]);
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
  });

  it.each(['grade', 'test'] as const)('registers AUTO and %s before the verifier first turn', async (namedMode) => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws', ownerId: 'su-verifier', autoMode: true,
      drainMode: false, namedMode, reason: `launch: --mode=${namedMode}`,
    });
    expect(err).toBeNull();
    expect(setModeMock.mock.calls.map((c) => (c[0] as { modeId: string }).modeId)).toEqual(['auto', namedMode]);
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
  });

  it('propagates the bounded DRAIN subject and exact standing instruction fact', async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-child',
      autoMode: true,
      drainMode: true,
      subject: 'bug-drain',
      instructions: 'DRAIN SCOPE — while \'drain\' is on, obey this verbatim: checkpoint incidental defects',
      ownerDirected: true,
      reason: 'fleet launch: --mode=drain (DRAIN implies AUTO)',
    });
    expect(err).toBeNull();
    expect(setModeMock.mock.calls[1][0]).toMatchObject({
      modeId: 'drain',
      subject: 'bug-drain',
      ownerDirected: true,
    });
    expect(assertFactMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'owner',
      scopeRef: 'su-child',
      key: 'mode-instructions:drain',
      body: 'DRAIN SCOPE — while \'drain\' is on, obey this verbatim: checkpoint incidental defects',
      workspaceId: 'ws',
    }));
    expect(retractFactMock).not.toHaveBeenCalled();
  });

  it('derives a fleet member scope without copying launcher leadership or owner authority', async () => {
    const inherited = "DRAIN SCOPE — while 'drain' is on, obey this verbatim: Lead the existing nonp2p-bug-drain fleet. (set by the owner; retracted when the mode is turned off)";
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws', ownerId: 'su-child', autoMode: true, drainMode: true,
      subject: 'nonp2p-bug-drain', instructions: inherited, ownerDirected: true,
      reason: 'fleet member launch',
      fleet: { slug: 'nonp2p-bug-drain', role: 'member' },
    });
    expect(err).toBeNull();
    expect(setModeMock.mock.calls[1][0]).toMatchObject({
      modeId: 'drain', subject: 'nonp2p-bug-drain', ownerDirected: false,
    });
    const fact = assertFactMock.mock.calls[0]?.[0] as { body: string };
    expect(fact.body).toContain("member of fleet 'nonp2p-bug-drain'");
    expect(fact.body).toContain('admitted claim spec');
    expect(fact.body).not.toContain('Lead the existing');
    expect(fact.body).not.toContain('set by the owner');
  });

  it('does not overwrite or clear a standing scope after a named-mode sticky refusal', async () => {
    setModeMock
      .mockResolvedValueOnce({ ok: true, noop: false })
      .mockResolvedValueOnce({ ok: false, stickyConflict: true });
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws', ownerId: 'su-child', autoMode: true, drainMode: true,
      instructions: '', reason: 'scope refresh refused',
    });
    expect(err).toBeNull();
    expect(assertFactMock).not.toHaveBeenCalled();
    expect(retractFactMock).not.toHaveBeenCalled();
  });

  it('does not assert replacement scope when the named-mode write was refused', async () => {
    setModeMock
      .mockResolvedValueOnce({ ok: true, noop: false })
      .mockResolvedValueOnce({ ok: false, stickyConflict: true });
    await syncLaunchModeToRegistry({
      workspaceId: 'ws', ownerId: 'su-child', autoMode: true, drainMode: true,
      instructions: 'Replacement scope', reason: 'scope refresh refused',
    });
    expect(assertFactMock).not.toHaveBeenCalled();
    expect(retractFactMock).not.toHaveBeenCalled();
  });

  it('does not treat an owner-sticky refusal (stickyConflict) as a hard failure', async () => {
    setModeMock.mockResolvedValueOnce({ ok: false, stickyConflict: true, switchedFrom: 'auto' });
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    // A peer/earlier launch already armed a stronger owner-directed mode — benign,
    // not a launch-blocking error.
    expect(err).toBeNull();
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a genuine setMode failure as a message, never throwing', async () => {
    setModeMock.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    expect(err).toBe('boom');
    expect(refreshControlAnchorMock).not.toHaveBeenCalled();
  });

  it('catches a thrown error (e.g. PG unreachable) and returns its message rather than throwing', async () => {
    setModeMock.mockRejectedValueOnce(new Error('pg down'));
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    expect(err).toBe('pg down');
  });
});
