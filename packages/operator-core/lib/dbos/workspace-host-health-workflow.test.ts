import { describe, expect, it, vi } from 'vitest';

const scheduled = vi.hoisted(() => [] as { name?: string; crontab?: string }[]);

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: (fn: unknown) => fn,
    registerScheduled: (_fn: unknown, cfg: { name?: string; crontab?: string }) => {
      scheduled.push(cfg);
    },
    runStep: vi.fn(),
  },
}));

import { WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB, WORKSPACE_HOST_STANDING_HEALTH_CRONTAB } from '../workspace-host/standing-health';
import {
  papercuspHostedRoleAttestationDbosRuntime,
  WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
  WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME,
  workspaceHostSpotReclaimSweepSummary,
  workspaceHostStandingHealthSummary,
} from './workspace-host-health-workflow';

describe('hosted GCP role attestation binding (WI-10005251)', () => {
  it('attests the configured hosting project', () => {
    const runtime = papercuspHostedRoleAttestationDbosRuntime({ PAPERCUSP_HOSTED_GCP_WORKSPACE_PROJECT: 'papercusp-hosted-workspaces' });
    expect(runtime.projectId).toBe('papercusp-hosted-workspaces');
  });

  it('skips a controller with no hosting project, or an invalid one, instead of failing the health tick', () => {
    expect(papercuspHostedRoleAttestationDbosRuntime({}).projectId).toBeNull();
    expect(papercuspHostedRoleAttestationDbosRuntime({ PAPERCUSP_HOSTED_GCP_WORKSPACE_PROJECT: 'Not A Project' }).projectId).toBeNull();
  });
});

describe('workspace-host standing health workflow', () => {
  it('is registered as a 15-minute DBOS schedule under its workflow name', () => {
    expect(WORKSPACE_HOST_STANDING_HEALTH_CRONTAB).toBe('*/15 * * * *');
    expect(scheduled).toContainEqual({
      name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
      crontab: WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
    });
  });

  it('stays quiet when every probed host is healthy', () => {
    expect(
      workspaceHostStandingHealthSummary({
        controllerId: 'c',
        outcomes: [
          { kind: 'attested', workspaceId: 'w', hostId: 'h1', status: 'healthy', checks: [] },
          { kind: 'skipped-fresh', workspaceId: 'w', hostId: 'h2', attestedAt: '2026-10-01T17:58:00.000Z' },
        ],
      }),
    ).toBeNull();
  });

  it('names every host that is not healthy or whose attestation was not recorded', () => {
    const summary = workspaceHostStandingHealthSummary({
      controllerId: 'c',
      outcomes: [
        { kind: 'attested', workspaceId: 'w', hostId: 'h1', status: 'healthy', checks: [] },
        { kind: 'attested', workspaceId: 'w', hostId: 'h2', status: 'unreachable', checks: [] },
        { kind: 'record-failed', workspaceId: 'w', hostId: 'h3', error: 'connection closed' },
      ],
    });
    expect(summary).toBe(
      '[workspace-host-health] c: 2 attested, 1 not healthy, 1 not recorded | w/h2=unreachable | w/h3 record failed: connection closed',
    );
  });

  it('says what happened to each reclaimed spot host (WI-10005210)', () => {
    const summary = workspaceHostStandingHealthSummary({
      controllerId: 'c',
      outcomes: [
        { kind: 'attested', workspaceId: 'w', hostId: 'a', status: 'unreachable', checks: [], recovery: { kind: 'restart-enqueued', operationId: 'op-1' } },
        { kind: 'attested', workspaceId: 'w', hostId: 'b', status: 'unreachable', checks: [], recovery: { kind: 'restart-skipped', reason: 'another lifecycle operation holds the host' } },
        { kind: 'attested', workspaceId: 'w', hostId: 'c', status: 'unreachable', checks: [], recovery: { kind: 'restart-failed', error: 'quota' } },
      ],
    });
    expect(summary).toBe(
      '[workspace-host-health] c: 3 attested, 3 not healthy, 0 not recorded' +
        ' | w/a=unreachable (spot reclaimed, restart enqueued op-1)' +
        ' | w/b=unreachable (spot reclaimed, restart skipped: another lifecycle operation holds the host)' +
        ' | w/c=unreachable (spot reclaimed, restart FAILED: quota)',
    );
  });
});

describe('workspace-host spot-reclaim sweep workflow (WI-10005210, D-028)', () => {
  it('is registered as a 2-minute DBOS schedule under its own workflow name', () => {
    expect(WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB).toBe('*/2 * * * *');
    expect(WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME).not.toBe(WORKSPACE_HOST_HEALTH_WORKFLOW_NAME);
    expect(scheduled).toContainEqual({
      name: WORKSPACE_HOST_SPOT_RECLAIM_WORKFLOW_NAME,
      crontab: WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB,
    });
  });

  it('stays quiet every 2 minutes while no spot host was reclaimed, even if one could not be read', () => {
    expect(
      workspaceHostSpotReclaimSweepSummary({
        controllerId: 'c',
        outcomes: [
          { kind: 'not-reclaimed', workspaceId: 'w', hostId: 'up', status: 'RUNNING' },
          { kind: 'unread', workspaceId: 'w', hostId: 'blind', detail: '403' },
        ],
      }),
    ).toBeNull();
  });

  it('names each reclaimed host with what was done about it, and any attestation that was not recorded', () => {
    expect(
      workspaceHostSpotReclaimSweepSummary({
        controllerId: 'c',
        outcomes: [
          { kind: 'not-reclaimed', workspaceId: 'w', hostId: 'up', status: 'RUNNING' },
          {
            kind: 'attested',
            workspaceId: 'w',
            hostId: 'down',
            status: 'unreachable',
            checks: [],
            recovery: { kind: 'restart-enqueued', operationId: 'op-1' },
          },
          { kind: 'record-failed', workspaceId: 'w', hostId: 'down2', error: 'connection closed' },
        ],
      }),
    ).toBe(
      '[workspace-host-spot-reclaim] c: 3 spot host(s) read' +
        ' | w/down=unreachable (spot reclaimed, restart enqueued op-1)' +
        ' | w/down2 record failed: connection closed',
    );
  });
});
