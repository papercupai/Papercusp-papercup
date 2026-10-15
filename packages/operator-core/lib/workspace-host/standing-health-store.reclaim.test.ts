import { describe, expect, it, vi } from 'vitest';
import {
  prepareWorkspaceHostReclaimRestart,
  WORKSPACE_HOST_SPOT_RECLAIM_ACTOR,
  type WorkspaceHostReclaimRestartDeps,
} from './standing-health-store';

const target = { workspaceId: 'papercusp-workspace', hostId: 'host-1' };
const OP = '1b4e28ba-2fa1-51d2-883f-0016d3cca427';

function deps(overrides: Partial<WorkspaceHostReclaimRestartDeps> & { desiredState?: string | null } = {}) {
  const readTarget = vi.fn(async () => ({
    id: 'host-1',
    connectionId: 'conn-1',
    desired: { scope: { kind: 'project', id: 'papercusp-hosted-workspaces' } },
  }));
  const readConnection = vi.fn(async () => ({
    connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'hosted:v1' }, provider: { region: 'us-central1' } },
  }));
  return {
    readDesiredState: vi.fn(async () => ('desiredState' in overrides ? overrides.desiredState! : 'running')),
    readTarget,
    readConnection,
    ...overrides,
  } as unknown as Required<WorkspaceHostReclaimRestartDeps> & {
    readTarget: typeof readTarget;
    readConnection: typeof readConnection;
  };
}

describe('prepareWorkspaceHostReclaimRestart (WI-10005210)', () => {
  it('builds the same lifecycle start the action route builds: stored connection, desired scope, system actor', async () => {
    const d = deps();
    const plan = await prepareWorkspaceHostReclaimRestart(target, OP, d);
    expect(plan).toEqual({
      kind: 'restart',
      operationId: OP,
      input: {
        workspaceId: 'papercusp-workspace',
        hostId: 'host-1',
        action: 'start',
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'hosted:v1' },
          provider: { region: 'us-central1' },
          scope: { kind: 'project', id: 'papercusp-hosted-workspaces' },
        },
        operationId: OP,
        actorId: WORKSPACE_HOST_SPOT_RECLAIM_ACTOR,
      },
    });
    expect(d.readConnection).toHaveBeenCalledWith('papercusp-workspace', 'conn-1');
  });

  it.each(['degraded'])('restarts a host whose desired state is still %s', async (state) => {
    const plan = await prepareWorkspaceHostReclaimRestart(target, OP, deps({ desiredState: state }));
    expect(plan.kind).toBe('restart');
  });

  it.each(['stopped', 'absent', 'repairing', 'provisioning'])(
    'never restarts a host the controller moved to %s after the target list (an ordered stop, not a reclaim)',
    async (state) => {
      const d = deps({ desiredState: state });
      const plan = await prepareWorkspaceHostReclaimRestart(target, OP, d);
      expect(plan).toEqual({ kind: 'skip', reason: `desired state is now '${state}', so the stop was ordered, not a reclaim` });
      expect(d.readTarget).not.toHaveBeenCalled();
    },
  );

  it('skips, naming why, when the row or its connection is gone', async () => {
    expect(await prepareWorkspaceHostReclaimRestart(target, OP, deps({ desiredState: null }))).toEqual({
      kind: 'skip',
      reason: 'the host row is gone',
    });
    const noConnection = deps({ readConnection: vi.fn(async () => null) });
    expect(await prepareWorkspaceHostReclaimRestart(target, OP, noConnection)).toEqual({
      kind: 'skip',
      reason: "workspace-host connection 'conn-1' was not found",
    });
  });

  it('never restarts an AWS spot host: EC2 restarts an interrupted persistent spot instance itself (WI-10005389)', async () => {
    const d = deps({
      readTarget: vi.fn(async () => ({
        id: 'host-1',
        connectionId: 'conn-1',
        desired: { target: 'aws', scope: { kind: 'account', id: '413781344298' } },
      })) as never,
    });
    expect(await prepareWorkspaceHostReclaimRestart(target, OP, d)).toEqual({
      kind: 'skip',
      reason: 'EC2 restarts an interrupted persistent spot instance itself; a controller start is refused',
    });
    expect(d.readConnection).not.toHaveBeenCalled();
  });
});
