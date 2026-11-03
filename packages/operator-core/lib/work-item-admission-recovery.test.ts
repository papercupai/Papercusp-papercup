import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  presence: vi.fn(), modes: vi.fn(), policy: vi.fn(), gate: vi.fn(), fleet: vi.fn(), state: vi.fn(),
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: io.presence }));
vi.mock('./modes/store', () => ({ getModes: io.modes }));
vi.mock('./work-scope-policy', () => ({ readWorkScopePolicy: io.policy, gateWorkScope: io.gate }));
vi.mock('./scheduler/fleet-scope-admission', () => ({ admitWorkItemForFleetTarget: io.fleet }));
vi.mock('./operator-state-pg', () => ({ readOperatorState: io.state }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: {} }),
}));
// This suite isolates session-policy composition. The chain integration suite
// separately exercises authenticated replay through the real dispatch gates.
vi.mock('./work-item-admission-authority', async (original) => ({
  ...await original<typeof import('./work-item-admission-authority')>(),
  authorizeAdmissionReplay: vi.fn(async () => {}),
}));

import { authorizeAdmissionRecovery, withAdmissionPromoterLock } from './work-item-admission-recovery';

const scope = { workspaceId: 'ws-authority', harnessSlug: 'papercusp', workItemId: 'WI-original' };
const request = { caller: 'requester', target: 'reviewer' };
beforeEach(() => {
  vi.resetAllMocks();
  io.presence.mockImplementation(async () => ({ workspaceId: scope.workspaceId, revoked: false }));
  io.modes.mockResolvedValue([]);
  io.policy.mockResolvedValue({ mode: 'enforce', allowHarnesses: ['papercusp'] });
  io.gate.mockResolvedValue({ allowed: true });
  io.fleet.mockResolvedValue({ allowed: true });
  io.state.mockResolvedValue(null);
});

describe('production recovery authorization (real policy composition, mocked store I/O)', () => {
  it('reads current workspace, per-agent fleet override and confinement for BOTH actors', async () => {
    await authorizeAdmissionRecovery(scope, request);
    for (const actor of [request.caller, request.target]) {
      expect(io.presence).toHaveBeenCalledWith(actor);
      expect(io.modes).toHaveBeenCalledWith(scope.workspaceId, actor);
      expect(io.gate).toHaveBeenCalledWith('coord:dispatch', {
        harness: scope.harnessSlug, workItem: scope.workItemId, actor,
      }, await io.policy());
      expect(io.fleet).toHaveBeenCalledWith({
        workItemId: scope.workItemId, target: actor, harness: scope.harnessSlug, workspaceId: scope.workspaceId,
      });
    }
    expect(io.state).toHaveBeenCalledWith('operator_session_confinements', scope.workspaceId, { fresh: true });
  });

  it.each([request.caller, request.target])('refuses absent, revoked and cross-workspace actor %s', async (actor) => {
    for (const invalid of [null, { workspaceId: scope.workspaceId, revoked: true }, { workspaceId: 'other' }]) {
      io.presence.mockImplementation(async (id) => id === actor ? invalid : { workspaceId: scope.workspaceId });
      await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('absent, revoked, or outside');
    }
  });

  it.each([request.caller, request.target])('refuses AUDIT remediation for %s', async (actor) => {
    io.modes.mockImplementation(async (_ws, id) => id === actor ? [{ mode: 'audit' }] : []);
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('AUDIT mode');
  });

  it.each([request.caller, request.target])('rechecks a revoked fleet override for %s on every replay', async (actor) => {
    await authorizeAdmissionRecovery(scope, request);
    io.fleet.mockImplementation(async ({ target }) => target === actor
      ? { allowed: false, reason: 'effective member override denied original item' } : { allowed: true });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('effective member override');
  });

  it('fails closed on workspace denial and policy store failure', async () => {
    io.gate.mockResolvedValue({ allowed: false, message: 'workspace scope denied' });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('workspace scope denied');
    expect(io.fleet).not.toHaveBeenCalled();
    io.gate.mockRejectedValue(new Error('policy unavailable'));
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('policy unavailable');
  });

  it.each([request.caller, request.target])('honors current claim confinement of %s even through the system routine', async (actor) => {
    io.state.mockResolvedValue({ sessions: { [actor]: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confinement: { denyTools: ['work_items:claim'], imposedBy: 'director', reason: 'no claims' },
    } } });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('no claims');
  });

  it('does not require the recipient to have the caller-only dispatch power', async () => {
    const row = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confinement: { denyTools: ['coord:dispatch'], imposedBy: 'director', reason: 'no delegation' },
    };
    io.state.mockResolvedValue({ sessions: { [request.target]: row } });
    await expect(authorizeAdmissionRecovery(scope, request)).resolves.toBeUndefined();
    io.state.mockResolvedValue({ sessions: { [request.caller]: row } });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('no delegation');
  });

  it('does not turn an interrupted confinement read into an authorization grant', async () => {
    io.state.mockRejectedValue(new Error('confinement store unavailable'));
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('confinement store unavailable');
  });
});

describe('admission promoter lock attribution', () => {
  it('identifies a lock-client reserve timeout and preserves the driver error code', async () => {
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
      code: 'CONNECT_TIMEOUT',
    });
    const reserve = vi.fn().mockRejectedValue(timeout);
    const action = vi.fn(async () => 'screened');
    const lockSql = { reserve } as never;

    const failure = await withAdmissionPromoterLock({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
    }, lockSql, action).then(() => null, (error: unknown) => error as Error & {
      code?: string;
      cause?: unknown;
    });

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('work-item-admission-promoter lock-client phase=reserve');
    expect(failure?.message).toContain(timeout.message);
    expect(failure?.name).toBe(timeout.name);
    expect(failure?.code).toBe(timeout.code);
    expect(failure?.cause).toBe(timeout);
    expect(reserve).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });
});
