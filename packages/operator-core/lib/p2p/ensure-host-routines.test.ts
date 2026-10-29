import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSweep = vi.fn();
const ensureSupervision = vi.fn();
const resolveIdentity = vi.fn();
const loadKeypair = vi.fn();
const activeWs = vi.fn();
const orgSql = vi.fn().mockResolvedValue([]);

vi.mock('../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: () => 'papercusp',
}));
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: (...args: unknown[]) => activeWs(...args),
}));
vi.mock('../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: (...args: unknown[]) => resolveIdentity(...args),
}));
vi.mock('../identity/attest', () => ({
  loadOrGenerateDeviceKeypair: (...args: unknown[]) => loadKeypair(...args),
}));
vi.mock('../identity/device-keychain-id', () => ({
  resolveDeviceKeychainId: (githubUserId: number) => `${githubUserId}:fake-machine`,
}));
vi.mock('../harness/routines/sweep-orphaned-foreign-harnesses-action', () => ({
  SWEEP_ORPHANED_FOREIGN_HARNESSES_ROUTINE_NAME: 'sweep-orphaned-foreign-harnesses',
  ensureSweepOrphanedForeignHarnessesRoutine: (...args: unknown[]) => ensureSweep(...args),
}));
vi.mock('../harness/routines/foreign-supervision-action', () => ({
  ensureP2pForeignSupervisionRoutine: (...args: unknown[]) => ensureSupervision(...args),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: orgSql }),
}));

import {
  ensureP2pHostRoutinesForWorkspace,
  ensureP2pHostRoutinesSeededOnce,
  _resetEnsureP2pHostRoutinesForTests,
} from './ensure-host-routines';

const WORKSPACE_ID = 'ws-1';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ensureP2pHostRoutinesForWorkspace', () => {
  beforeEach(() => {
    ensureSweep.mockReset().mockResolvedValue({ id: 'rt_sweep' });
    ensureSupervision.mockReset().mockResolvedValue({ id: 'rt_supervision' });
    orgSql.mockReset().mockResolvedValue([]);
    resolveIdentity.mockReset();
    loadKeypair.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('seeds orphan sweep + foreign supervision when identity resolves', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      installSlug: 'papercusp',
      sweepSeeded: true,
      supervisionSeeded: true,
      skippedReasons: [],
    });
    expect(ensureSweep).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, installSlug: 'papercusp' },
      expect.anything(),
    );
    const [queryParts, ...queryValues] = orgSql.mock.calls[0]!;
    expect(queryParts.join('')).toContain('UPDATE harness_shared.routines AS legacy');
    expect(queryParts.join('')).toContain('AND NOT EXISTS');
    expect(queryValues).toEqual(expect.arrayContaining([
      WORKSPACE_ID,
      'default',
      'papercusp',
      'sweep-orphaned-foreign-harnesses',
    ]));
    expect(ensureSupervision).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        installSlug: 'papercusp',
        host: { responderGithubUserId: 42, responderDevicePubkey: 'PUBKEY==' },
      },
      expect.anything(),
    );
  });

  it('seeds only the identity-free sweep when gh is not authenticated', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'gh_auth_required' });

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.sweepSeeded).toBe(true);
    expect(result.supervisionSeeded).toBe(false);
    expect(result.skippedReasons.some((r) => r.includes('gh not authenticated'))).toBe(true);
    expect(ensureSupervision).not.toHaveBeenCalled();
  });

  it('keeps supervision fail-closed with a null device pubkey when keychain resolution fails', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockRejectedValue(new Error('keychain locked'));

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.supervisionSeeded).toBe(true);
    expect(result.skippedReasons).toContain('device keypair: keychain locked');
    expect(ensureSupervision).toHaveBeenCalledWith(
      expect.objectContaining({
        host: { responderGithubUserId: 42, responderDevicePubkey: null },
      }),
      expect.anything(),
    );
  });

  it('never throws when one ensure call rejects and still attempts the other', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    ensureSweep.mockRejectedValue(new Error('boom'));

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.sweepSeeded).toBe(false);
    expect(result.supervisionSeeded).toBe(true);
    expect(result.skippedReasons.some((r) => r.includes('boom'))).toBe(true);
  });
});

describe('ensureP2pHostRoutinesSeededOnce', () => {
  beforeEach(() => {
    _resetEnsureP2pHostRoutinesForTests();
    ensureSweep.mockReset().mockResolvedValue({ id: 'rt_sweep' });
    ensureSupervision.mockReset().mockResolvedValue({ id: 'rt_supervision' });
    resolveIdentity.mockReset().mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockReset().mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    activeWs.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('seeds under activeWorkspaceId(), never a loop variable from the registry list', async () => {
    activeWs.mockReturnValue('papercusp-workspace');
    ensureP2pHostRoutinesSeededOnce(['default', '*', 'papercusp-workspace']);
    await flush();

    expect(ensureSweep).toHaveBeenCalledTimes(1);
    expect(ensureSupervision).toHaveBeenCalledTimes(1);
    expect(ensureSupervision).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'papercusp-workspace' }),
      expect.anything(),
    );
  });

  it('loudly skips when activeWorkspaceId() is not a valid p2p partition', async () => {
    activeWs.mockReturnValue('default');
    ensureP2pHostRoutinesSeededOnce(['default']);
    await flush();

    expect(ensureSweep).not.toHaveBeenCalled();
    expect(ensureSupervision).not.toHaveBeenCalled();
  });

  it('is once-per-process', async () => {
    activeWs.mockReturnValue('papercusp-workspace');
    ensureP2pHostRoutinesSeededOnce([]);
    await flush();
    activeWs.mockReturnValue('ws-2');
    ensureP2pHostRoutinesSeededOnce([]);
    await flush();

    expect(ensureSweep).toHaveBeenCalledTimes(1);
    expect(ensureSupervision).toHaveBeenCalledTimes(1);
  });
});
