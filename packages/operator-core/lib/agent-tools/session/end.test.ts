/**
 * session:end — WI-6638. The verb that lets a finished agent session close its own
 * terminal window, instead of idling in an open tab holding a real `claude` process
 * forever (measured: 52 such trees, oldest 14 days, 14.4 GB).
 *
 * The SAFETY property is enforced host-side (`shutdownRefusalReason` in
 * psu-pty-host.mjs, tested in apps/operator/lib/psu-pty-host.test.ts) because only
 * the host can see its own launch env and its own stdin. What is tested here is the
 * caller-facing contract: every host verdict must arrive as a DISTINCT, self-
 * explaining outcome — a refusal is a correct answer about an owner-attended window,
 * and must never be indistinguishable from a transport miss the caller should retry.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
}));
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHost: vi.fn(() => null),
  findLiveHostAsync: vi.fn(async () => null),
  hostSupports: vi.fn(() => true),
  shutdownViaPty: vi.fn(async () => 'sent'),
}));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  markAdvSessionShutdownAcceptedByOwner: vi.fn(async () => true),
}));
vi.mock('../../carry-note', () => ({ getLoopCarryNote: vi.fn(async () => null) }));
vi.mock('../../session-brief', () => ({ markSessionBriefShutdown: vi.fn(async () => true) }));
// Keep the module graph light: transitive imports of the REAL
// wind-down-disposition module loaded via importOriginal below.
vi.mock('../../modes/store', () => ({ getModeSubject: vi.fn() }));
vi.mock('../coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('../../goals/wind-down-disposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../goals/wind-down-disposition')>();
  return {
    ...real,
    activeGoalForOwner: vi.fn(async () => null),
    applyGoalDisposition: vi.fn(async () => {}),
    deliverGoalWindDownReport: vi.fn(async () => {}),
    windDownDispositionGateEnabled: vi.fn(async () => true),
    // P-009 acceptance gate (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2).
    // MUST be mocked: the real one resolves its deps via `await import('../rubrics')` /
    // `('../scorecards')` and queries Postgres. Left real, this unit test's verdict flips
    // with PG REACHABILITY — the gate is positive-finding-only (`catch → satisfied:true`),
    // so it PASSES on a box with no PG and REFUSES on one with PG, where the fake goal
    // naturally has no acceptance rubric. That is what made this file "fail repeatedly"
    // (EI-20714633008328432) while reading green wherever PG was down. The gate's own
    // behavior is covered by its own tests; here we assert only that session:end CONSULTS
    // it and honors BOTH verdicts.
    evaluateGoalAcceptanceGate: vi.fn(async () => ({ satisfied: true })),
  };
});

import { getLoopStatus } from '../../harness/routines/loop';
import { shutdownViaPty } from '../../events/await/psu-pty-discovery';
import { markAdvSessionShutdownAcceptedByOwner } from '../../adv-sessions';
import { markSessionBriefShutdown } from '../../session-brief';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
  evaluateGoalAcceptanceGate,
} from '../../goals/wind-down-disposition';
import endTool, { shutdownNote } from './end';

it('opts out of the ambient workspace transaction for bounded shutdown', () => {
  // session:end never reads ctx.tx and must remain callable by a privileged
  // session even when every org-app pool slot is held by another call.
  expect((endTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

describe('shutdownNote (WI-6638)', () => {
  const RESULTS = [
    'sent',
    'no-host',
    'no-cap',
    'send-failed',
    'loop-armed',
    'refused-not-agent-launched',
    'refused-human-attended',
    'refused-agent-busy',
  ] as const;

  it('gives every host verdict its own distinct explanation', () => {
    const notes = RESULTS.map((r) => shutdownNote(r));
    expect(new Set(notes).size).toBe(RESULTS.length);
    for (const n of notes) expect(n.length).toBeGreaterThan(20);
  });

  it('tells a REFUSAL apart from a failure in the words themselves', () => {
    // The agent reading this must not "fix" a refusal by retrying: an owner-attended
    // window refusing to close is the system working, not an error.
    for (const r of ['refused-not-agent-launched', 'refused-human-attended'] as const) {
      expect(shutdownNote(r)).toMatch(/REFUSED/);
    }
    // agent-busy is the one refusal that IS retryable — it says so.
    expect(shutdownNote('refused-agent-busy')).toMatch(/retry/i);
    expect(shutdownNote('refused-human-attended')).toMatch(/not an error to retry around/i);
    // loop-armed is the operator-side precondition (the host has no DB to see it):
    // it must name the exact unblocking action, or the agent has no way forward.
    expect(shutdownNote('loop-armed')).toMatch(/REFUSED/);
    expect(shutdownNote('loop-armed')).toMatch(/loop:end/);
  });

  it('does not promise a closed window when nothing was closed', () => {
    expect(shutdownNote('sent')).toMatch(/will close/);
    for (const r of [
      'no-host',
      'no-cap',
      'send-failed',
      'loop-armed',
      'refused-human-attended',
    ] as const) {
      expect(shutdownNote(r)).not.toMatch(/will close/);
    }
  });

  it('falls back to a transport-miss note for an unknown verdict, never to silence', () => {
    const note = shutdownNote('something-new-from-a-future-host');
    expect(note).toMatch(/did not reach the host/);
    // The reassurance that matters when the outcome is unknown: nothing was killed.
    expect(note).toMatch(/nothing was killed/);
  });
});

/**
 * P-002 (goal-mode-design-intent-hardening-2026-08-16): the wind-down
 * disposition gate for LOOPLESS goal owners. A looped goal owner is already
 * forced through loop:end by the loop-armed refusal (tested above via
 * shutdownNote); this gate catches the owner with no armed loop, who would
 * otherwise close the window with the goal still active and no report sent.
 */
describe('session:end — the P-002 disposition gate for loopless goal owners', () => {
  const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
  const shutdownViaPtyMock = shutdownViaPty as unknown as ReturnType<typeof vi.fn>;
  const activeGoalForOwnerMock = activeGoalForOwner as unknown as ReturnType<typeof vi.fn>;
  const applyGoalDispositionMock = applyGoalDisposition as unknown as ReturnType<typeof vi.fn>;
  const deliverReportMock = deliverGoalWindDownReport as unknown as ReturnType<typeof vi.fn>;
  const gateEnabledMock = windDownDispositionGateEnabled as unknown as ReturnType<typeof vi.fn>;
  const acceptanceGateMock = evaluateGoalAcceptanceGate as unknown as ReturnType<typeof vi.fn>;
  const markShutdownAcceptedMock = markAdvSessionShutdownAcceptedByOwner as unknown as ReturnType<typeof vi.fn>;

  const ACTIVE_GOAL = {
    goalId: 'ship-paid-app-3f9a1c',
    title: 'Ship the paid app',
    installSlug: 'papercusp',
    recordedDisposition: null,
  };

  const run = (args: Record<string, unknown> = {}) =>
    (endTool as unknown as {
      handler: (
        a: unknown,
        ctx: unknown,
      ) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>;
    })
      .handler(args, {})
      .then((r) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true }));

  beforeEach(() => {
    getLoopStatusMock.mockReset();
    getLoopStatusMock.mockResolvedValue(null);
    shutdownViaPtyMock.mockClear();
    shutdownViaPtyMock.mockResolvedValue('sent');
    markShutdownAcceptedMock.mockClear();
    markShutdownAcceptedMock.mockResolvedValue(true);
    vi.mocked(markSessionBriefShutdown).mockReset();
    vi.mocked(markSessionBriefShutdown).mockResolvedValue(true);
    activeGoalForOwnerMock.mockReset();
    activeGoalForOwnerMock.mockResolvedValue(null);
    applyGoalDispositionMock.mockReset();
    applyGoalDispositionMock.mockResolvedValue(undefined);
    deliverReportMock.mockReset();
    deliverReportMock.mockResolvedValue(undefined);
    gateEnabledMock.mockReset();
    gateEnabledMock.mockResolvedValue(true);
    acceptanceGateMock.mockReset();
    acceptanceGateMock.mockResolvedValue({ satisfied: true });
  });

  it('REFUSES a loopless goal-mode wind-down without a disposition — naming the arg and all three values — and never reaches the host', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/\bdisposition\b/);
    for (const d of GOAL_DISPOSITIONS) expect(got.error).toContain(`'${d}'`);
    expect(got.error).toContain('session:end');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it('REFUSES a new loopless holder even when the goal carries an older disposition', async () => {
    activeGoalForOwnerMock.mockResolvedValue({ ...ACTIVE_GOAL, recordedDisposition: 'handoff' });

    const got = await run({});

    expect(got.isError).toBe(true);
    expect(got.error).toContain('disposition');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it('allows re-entrant session cleanup after a known-inactive loop already recorded disposition', async () => {
    getLoopStatusMock.mockResolvedValue({ active: false });
    activeGoalForOwnerMock.mockResolvedValue({ ...ACTIVE_GOAL, recordedDisposition: 'handoff' });

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.result).toBe('sent');
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
  });

  it('with a disposition: stamps the goal, delivers the owner report, then proceeds to shut down', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({ disposition: 'achieved', reason: 'goal complete' });
    expect(got.ok).toBe(true);
    expect(got.result).toBe('sent');
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        goalId: ACTIVE_GOAL.goalId,
        disposition: 'achieved',
        dispositionBy: 'su-caller-own-id',
      }),
    );
    expect(deliverReportMock).toHaveBeenCalledTimes(1);
    const [, delivered] = deliverReportMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(delivered.body)).toContain('goal complete');
  });

  it("P-009: an UNSATISFIED acceptance gate refuses 'achieved' — and refuses BEFORE the host shutdown", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    acceptanceGateMock.mockResolvedValue({
      satisfied: false,
      code: 'goal_acceptance_ungraded',
      message: 'REFUSED — no complete grading by a non-owner.',
    });
    const got = await run({ disposition: 'achieved', reason: 'I say it is done' });
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toBe('goal_acceptance_ungraded');
    // A refused acceptance claim must not still take the session down.
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
  });

  it("P-009: 'killed' never consults the acceptance gate — it carries no acceptance claim", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    // Armed to REFUSE: if 'killed' consulted the gate, this wind-down would fail.
    acceptanceGateMock.mockResolvedValue({ satisfied: false, code: 'goal_acceptance_ungraded', message: 'x' });
    const got = await run({ disposition: 'killed', reason: 'abandoning it' });
    expect(got.ok).toBe(true);
    expect(acceptanceGateMock).not.toHaveBeenCalled();
  });

  it('an ARMED loop takes precedence: the loop-armed refusal answers and the goal is never consulted (the gate lives at loop:end)', async () => {
    getLoopStatusMock.mockResolvedValue({ active: true, harnessSlug: 'papercusp' });
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.result).toBe('loop-armed');
    expect(activeGoalForOwnerMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it('a non-goal owner is unaffected', async () => {
    const got = await run({});
    expect(got.ok).toBe(true);
    expect(got.result).toBe('sent');
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
  });

  it('records the accepted shutdown only after the host acknowledges it', async () => {
    await run({ reason: 'finished' });
    expect(markShutdownAcceptedMock).toHaveBeenCalledWith('su-caller-own-id');

    markShutdownAcceptedMock.mockClear();
    shutdownViaPtyMock.mockResolvedValue('send-failed');
    const got = await run({ reason: 'transport miss' });
    expect(got.result).toBe('send-failed');
    expect(markShutdownAcceptedMock).not.toHaveBeenCalled();
  });

  it('records a consumer-attested durable wake cutoff after positive managed shutdown', async () => {
    const got = await run({ reason: 'finished' });
    expect(got.shutdownWakeGuardRecorded).toBe(true);
    expect(markSessionBriefShutdown).toHaveBeenCalledWith('su-caller-own-id', 'ws-1', {
      at: expect.any(String), by: 'su-caller-own-id',
    });
    expect(vi.mocked(shutdownViaPty).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(markSessionBriefShutdown).mock.invocationCallOrder[0]);
  });

  it.each(['no-host', 'no-cap', 'send-failed', 'refused-human-attended', 'refused-agent-busy'])
    ('does not invent a shutdown cutoff for host verdict %s', async (verdict) => {
      shutdownViaPtyMock.mockResolvedValue(verdict);
      const got = await run({});
      expect(got.shutdownWakeGuardRecorded).toBeNull();
      expect(markSessionBriefShutdown).not.toHaveBeenCalled();
    });

  it('reports missing cutoff persistence without pretending physical shutdown failed or replay safety passed', async () => {
    vi.mocked(markSessionBriefShutdown).mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await run({});
      expect(got).toMatchObject({ ok: true, result: 'sent', shutdownWakeGuardRecorded: false });
      expect(got.wakeSafetyWarning).toContain('unverified');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('durable wake cutoff was not recorded'));
    } finally { warn.mockRestore(); }
  });

  it('flag OFF disables the gate: the goal is never consulted', async () => {
    gateEnabledMock.mockResolvedValue(false);
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.result).toBe('sent');
    expect(activeGoalForOwnerMock).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a disposition-report failure downgrades to a warning and the wind-down proceeds', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    applyGoalDispositionMock.mockRejectedValue(new Error('goals table unreachable'));
    const got = await run({ disposition: 'killed' });
    expect(got.ok).toBe(true);
    expect(got.result).toBe('sent');
    expect(String(got.dispositionWarning)).toMatch(/goals:update/);
  });
});
