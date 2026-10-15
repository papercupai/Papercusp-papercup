/**
 * wake-executor-headless-presence-stamp.test.ts — WI-10005725.
 *
 * A resume-headless turn runs with no psu launcher, so no supervisor beat ever
 * reports its pid. The presence row kept the DEAD launcher pid of the session
 * being resumed; the liveness oracle's ESRCH probe outranks the turn's own fresh
 * activity, so a working turn read `ended` and the goal-holder respawner replaced
 * it. `defaultAccountHeadlessResumeTurn` must stamp the spawned child's pid/host
 * onto presence, and that best-effort stamp must never reject `pidRecorded`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';

const h = vi.hoisted(() => ({
  touchHeartbeat: vi.fn(async (_ownerId: string, _liveness?: unknown) => {}),
  setAdvSessionPid: vi.fn(async (..._args: unknown[]) => {}),
  completeSyncEnrolment: vi.fn(),
  finishSyncEnrolment: vi.fn(),
}));

vi.mock('../../agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/coordination/presence')>()),
  touchHeartbeat: h.touchHeartbeat,
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  setAdvSessionPid: h.setAdvSessionPid,
}));
vi.mock('../../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: () => ({}),
  completeSyncEnrolment: h.completeSyncEnrolment,
  finishSyncEnrolment: h.finishSyncEnrolment,
}));

import { defaultAccountHeadlessResumeTurn, type HeadlessResumeTurnInput } from './wake-executor';

const input: HeadlessResumeTurnInput = {
  pid: 424242,
  advSessionId: 33718,
  sessionWorkspaceId: 'papercusp-workspace',
  deliveryWorkspaceId: 'papercusp-workspace',
  coordOwnerId: 'su-test-resumed-headless',
  agent: 'claude',
  resumeId: '00000000-0000-4000-8000-000000000000',
  cwd: '/tmp',
  argv: ['claude', '--resume', '00000000-0000-4000-8000-000000000000'],
};

describe('WI-10005725 — resume-headless turns stamp their own pid onto presence', () => {
  beforeEach(() => {
    h.touchHeartbeat.mockReset().mockResolvedValue(undefined);
    h.setAdvSessionPid.mockReset().mockResolvedValue(undefined);
    h.completeSyncEnrolment.mockReset();
    h.finishSyncEnrolment.mockReset();
  });

  it('stamps the CHILD pid and this host, so the oracle probes the running turn', async () => {
    await defaultAccountHeadlessResumeTurn(input).pidRecorded;
    expect(h.touchHeartbeat).toHaveBeenCalledTimes(1);
    expect(h.touchHeartbeat).toHaveBeenCalledWith(input.coordOwnerId, {
      pid: input.pid,
      host: hostname(),
    });
    // The adv-session write is unchanged by the stamp.
    expect(h.setAdvSessionPid).toHaveBeenCalledWith(
      input.advSessionId,
      input.pid,
      undefined,
      input.sessionWorkspaceId,
    );
  });

  it('a failed presence stamp never rejects pidRecorded', async () => {
    h.touchHeartbeat.mockRejectedValue(new Error('presence store down'));
    await expect(defaultAccountHeadlessResumeTurn(input).pidRecorded).resolves.toBeUndefined();
    expect(h.setAdvSessionPid).toHaveBeenCalledTimes(1);
  });

  it('an adv-session write failure still surfaces through pidRecorded (contract unchanged)', async () => {
    h.setAdvSessionPid.mockRejectedValue(new Error('adv write failed'));
    await expect(defaultAccountHeadlessResumeTurn(input).pidRecorded).rejects.toThrow('adv write failed');
  });

  it('retains the declared route as references without persisting route credentials', async () => {
    await defaultAccountHeadlessResumeTurn({
      ...input,
      declaredAccountRoute: {
        mode: 'pin',
        accountId: 'reviewer-account',
        env: { OPENAI_API_KEY: 'private-route-credential' },
      } as HeadlessResumeTurnInput['declaredAccountRoute'],
    }).pidRecorded;
    const spec = h.completeSyncEnrolment.mock.calls[0][1];
    expect(spec.detail.declaredAccountRoute).toEqual({ mode: 'pin', accountId: 'reviewer-account' });
    expect(JSON.stringify(spec)).not.toContain('private-route-credential');
  });

  it('retains the quota failure and redacts credentials before classifier truncation', () => {
    const secret = `sk-${'a'.repeat(240)}`;
    const accounting = defaultAccountHeadlessResumeTurn(input);
    accounting.finish({
      exitCode: 1,
      signal: null,
      stdoutTail: `Usage limit reached; api_key=${secret}`,
      stderrTail: '',
    });
    const close = h.finishSyncEnrolment.mock.calls[0][1];
    expect(close).toMatchObject({ state: 'exited', exitCode: 1 });
    expect(close.exitReason).toMatch(/^usage_limit:.*Usage limit reached/);
    expect(close.exitReason).toContain('[redacted]');
    expect(close.exitReason).not.toContain('sk-');
    expect(close.exitReason).not.toContain('a'.repeat(16));
  });

  it('records a Codex protocol failure even when the CLI exits zero', () => {
    defaultAccountHeadlessResumeTurn({ ...input, agent: 'codex' }).finish({
      exitCode: 0,
      signal: null,
      stdoutTail: JSON.stringify({ type: 'turn.failed', error: { message: 'insufficient_quota' } }),
      stderrTail: '',
    });
    expect(h.finishSyncEnrolment.mock.calls[0][1]).toMatchObject({
      state: 'exited',
      exitCode: 0,
      exitReason: expect.stringMatching(/^usage_limit:/),
    });
  });

  it.each(['claude', 'codex'])('does not retain successful %s model output and closes once', (agent) => {
    const accounting = defaultAccountHeadlessResumeTurn({ ...input, agent });
    const exit = {
      exitCode: 0,
      signal: null,
      stdoutTail: agent === 'codex'
        ? `${JSON.stringify({ type: 'item.completed', item: { text: 'private successful answer' } })}\n${JSON.stringify({ type: 'turn.completed' })}`
        : 'private successful answer',
      stderrTail: '',
    };
    accounting.finish(exit);
    accounting.finish(exit);
    expect(h.finishSyncEnrolment).toHaveBeenCalledTimes(1);
    expect(h.finishSyncEnrolment.mock.calls[0][1]).toEqual({ state: 'exited', exitCode: 0, exitReason: null });
  });

  it('preserves the existing signal termination reason', () => {
    defaultAccountHeadlessResumeTurn(input).finish({
      exitCode: null,
      signal: 'SIGTERM',
      stdoutTail: '',
      stderrTail: '',
    });
    expect(h.finishSyncEnrolment.mock.calls[0][1]).toEqual({ state: 'killed', exitCode: null, exitReason: 'SIGTERM' });
  });
});
