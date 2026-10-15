import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostHealthAttestation } from '@papercusp/deployment-driver';
import type { WorkspaceHostAgentCredentialExpiryReading } from './agent-credential-expiry';
import type { WorkspaceHostSoakInstanceReading, WorkspaceHostSoakReachOutcome, WorkspaceHostSoakSubject } from './soak';
import {
  probeWorkspaceHostStandingHealth,
  runWorkspaceHostSpotReclaimSweep,
  runWorkspaceHostStandingHealthPass,
  type WorkspaceHostSpotReclaimSweepRuntime,
  workspaceHostReclaimOperationId,
  workspaceHostSpotReclaimed,
  workspaceHostStandingHealthIsFresh,
  WORKSPACE_HOST_SPOT_RECLAIMED_CHECK,
  type WorkspaceHostReclaimRestartSeams,
  WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS,
  WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID,
  type WorkspaceHostStandingHealthRuntime,
  type WorkspaceHostStandingHealthSeams,
  type WorkspaceHostStandingHealthTarget,
} from './standing-health';

const NOW = new Date('2026-10-01T18:00:00.000Z');
const CONTROLLER = 'papercusp-workspace-host-controller:bg-host-3270';
const WS = 'papercusp-workspace';
const IMAGE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918';

function running(instanceId: string): WorkspaceHostSoakInstanceReading {
  return { kind: 'observed', status: 'RUNNING', instanceId, sourceImage: IMAGE };
}

interface HostScript {
  reading?: WorkspaceHostSoakInstanceReading | Error;
  reach?: WorkspaceHostSoakReachOutcome | Error;
  seamsError?: Error;
  /** When set, the seam exposes `readAgentCredentialExpiry` and answers with this. */
  agentLogins?: WorkspaceHostAgentCredentialExpiryReading | Error;
}

function fakeRuntime(
  targets: WorkspaceHostStandingHealthTarget[],
  hosts: Record<string, HostScript>,
  options: { recordFails?: Set<string> } = {},
) {
  const recorded: { workspaceId: string; attestation: WorkspaceHostHealthAttestation }[] = [];
  const steps: string[] = [];
  const reachSubjects: WorkspaceHostSoakSubject[] = [];
  const agentLoginReads: string[] = [];
  const listTargets = vi.fn(async () => targets);
  const runtime: WorkspaceHostStandingHealthRuntime = {
    step: async (name, fn) => {
      steps.push(name);
      return fn();
    },
    controllerId: CONTROLLER,
    listTargets,
    resolveSeams: async ({ hostId }): Promise<WorkspaceHostStandingHealthSeams> => {
      const script = hosts[hostId] ?? {};
      if (script.seamsError) throw script.seamsError;
      return {
        readInstance: async () => {
          if (script.reading instanceof Error) throw script.reading;
          return script.reading ?? running(`inst-${hostId}`);
        },
        probeFor: (subject) => ({
          probeReach: async () => {
            reachSubjects.push(subject);
            if (script.reach instanceof Error) throw script.reach;
            return script.reach ?? { kind: 'reached' };
          },
          ...(script.agentLogins !== undefined
            ? {
                readAgentCredentialExpiry: async () => {
                  agentLoginReads.push(subject.hostId);
                  if (script.agentLogins instanceof Error) throw script.agentLogins;
                  return script.agentLogins!;
                },
              }
            : {}),
        }),
      };
    },
    recordHealth: async (workspaceId, attestation) => {
      if (options.recordFails?.has(attestation.hostId)) throw new Error('connection closed');
      recorded.push({ workspaceId, attestation });
    },
    now: () => NOW,
  };
  return { runtime, recorded, steps, reachSubjects, agentLoginReads, listTargets };
}

const target = (hostId: string, healthAttestedAt: string | null = null): WorkspaceHostStandingHealthTarget => ({
  workspaceId: WS,
  hostId,
  healthAttestedAt,
});

describe('runWorkspaceHostStandingHealthPass', () => {
  it('attests each due host, skips a host an active soak attested moments ago, and writes no vacuous stability checks', async () => {
    const soakAttestedAt = new Date(NOW.getTime() - 2 * 60_000).toISOString();
    const { runtime, recorded, steps, reachSubjects, listTargets } = fakeRuntime(
      [target('host-healthy'), target('host-iap-down'), target('host-soaking', soakAttestedAt)],
      { 'host-iap-down': { reach: { kind: 'transport-failure', detail: 'ssh exited 255' } } },
    );

    const result = await runWorkspaceHostStandingHealthPass(runtime);

    expect(listTargets).toHaveBeenCalledWith(CONTROLLER);
    expect(steps).toEqual([
      'standing-health-list',
      `standing-health-host:${WS}:host-healthy`,
      `standing-health-host:${WS}:host-iap-down`,
    ]);
    expect(result.outcomes.map((outcome) => [outcome.hostId, outcome.kind])).toEqual([
      ['host-healthy', 'attested'],
      ['host-iap-down', 'attested'],
      ['host-soaking', 'skipped-fresh'],
    ]);
    expect(recorded.map((row) => row.attestation.hostId)).toEqual(['host-healthy', 'host-iap-down']);

    const healthy = recorded[0]!.attestation;
    expect(healthy).toEqual({
      hostId: 'host-healthy',
      observedAt: NOW.toISOString(),
      status: 'healthy',
      checks: [
        { name: 'compute-running', ok: true, detail: 'RUNNING' },
        { name: 'controller-reach', ok: true, detail: 'conduit executable' },
      ],
    });
    expect(recorded[0]!.workspaceId).toBe(WS);

    const iapDown = recorded[1]!.attestation;
    expect(iapDown.status).toBe('degraded');
    expect(iapDown.checks).toContainEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'transport-failure: ssh exited 255',
    });

    // The reach is pinned to the instance the provider just reported, under the standing subject id.
    expect(reachSubjects.map((subject) => [subject.hostId, subject.instanceId, subject.soakId])).toEqual([
      ['host-healthy', 'inst-host-healthy', WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID],
      ['host-iap-down', 'inst-host-iap-down', WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID],
    ]);
    for (const row of recorded) {
      expect(row.attestation.checks.map((check) => check.name)).not.toContain('incarnation-stable');
      expect(row.attestation.checks.map((check) => check.name)).not.toContain('image-stable');
    }
  });

  it('keeps going after one host fails to record, and reports that host as not recorded', async () => {
    const { runtime, recorded } = fakeRuntime([target('host-a'), target('host-b')], {}, { recordFails: new Set(['host-a']) });

    const result = await runWorkspaceHostStandingHealthPass(runtime);

    expect(result.outcomes[0]).toEqual({ kind: 'record-failed', workspaceId: WS, hostId: 'host-a', error: 'connection closed' });
    expect(result.outcomes[1]).toMatchObject({ kind: 'attested', hostId: 'host-b', status: 'healthy' });
    expect(recorded.map((row) => row.attestation.hostId)).toEqual(['host-b']);
  });

  it('lists nothing and probes nothing for a process that controls no host', async () => {
    const { runtime, recorded, steps } = fakeRuntime([], {});
    const result = await runWorkspaceHostStandingHealthPass(runtime);
    expect(result).toEqual({ controllerId: CONTROLLER, outcomes: [] });
    expect(steps).toEqual(['standing-health-list']);
    expect(recorded).toEqual([]);
  });
});

describe('probeWorkspaceHostStandingHealth', () => {
  it('reports a stopped instance as unreachable and does not spend an IAP reach on it', async () => {
    const { runtime, reachSubjects } = fakeRuntime([], {
      h: { reading: { kind: 'observed', status: 'TERMINATED', instanceId: 'i-1', sourceImage: IMAGE } },
    });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unreachable');
    expect(attestation.checks).toEqual([
      { name: 'compute-running', ok: false, detail: 'TERMINATED' },
      { name: 'controller-reach', ok: null, detail: 'not attempted: the instance is TERMINATED, not RUNNING' },
    ]);
    expect(reachSubjects).toEqual([]);
  });

  it('reports an absent instance as unreachable', async () => {
    const { runtime } = fakeRuntime([], { h: { reading: { kind: 'absent' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unreachable');
    expect(attestation.checks[0]).toEqual({ name: 'compute-running', ok: false, detail: 'instance absent' });
  });

  it('attests "unknown", never healthy and never silence, when the provider cannot be read', async () => {
    const { runtime, reachSubjects } = fakeRuntime([], { h: { reading: { kind: 'unreadable', detail: 'ETIMEDOUT' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks).toEqual([
      { name: 'compute-running', ok: null, detail: 'provider read failed: ETIMEDOUT' },
      { name: 'controller-reach', ok: null, detail: 'not attempted: the provider could not be read' },
    ]);
    expect(reachSubjects).toEqual([]);
  });

  it('treats a provider read that throws like an unreadable one', async () => {
    const { runtime } = fakeRuntime([], { h: { reading: new Error('socket hang up') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks[0]).toEqual({ name: 'compute-running', ok: null, detail: 'provider read failed: socket hang up' });
  });

  it('still attests a host whose seams the controller cannot resolve, naming why', async () => {
    const { runtime } = fakeRuntime([], { h: { seamsError: new Error('gcp_workspace_host_hosted_connection_missing') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks.every((check) => check.ok === null)).toBe(true);
    expect(attestation.checks[0]!.detail).toContain('gcp_workspace_host_hosted_connection_missing');
  });

  it('records a reach that throws as a transport failure', async () => {
    const { runtime } = fakeRuntime([], { h: { reach: new Error('iap tunnel refused') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('degraded');
    expect(attestation.checks[1]).toEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'transport-failure: iap tunnel refused',
    });
  });

  it('distinguishes a host that answered without its conduit from one that never answered', async () => {
    const { runtime } = fakeRuntime([], { h: { reach: { kind: 'conduit-missing', detail: 'initializer absent' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.checks[1]).toEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'conduit-missing: initializer absent',
    });
  });
});

describe('workspaceHostStandingHealthIsFresh', () => {
  const nowMs = NOW.getTime();
  it('is fresh only strictly inside the window', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', new Date(nowMs - 60_000).toISOString()), nowMs)).toBe(true);
    expect(
      workspaceHostStandingHealthIsFresh(
        target('h', new Date(nowMs - WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS).toISOString()),
        nowMs,
      ),
    ).toBe(false);
  });

  it('is never fresh for a host that was never attested or whose timestamp does not parse', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', null), nowMs)).toBe(false);
    expect(workspaceHostStandingHealthIsFresh(target('h', 'not-a-date'), nowMs)).toBe(false);
  });

  it('a 15-minute standing write is not fresh at the next tick, so the pass never starves itself', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', new Date(nowMs - 15 * 60_000).toISOString()), nowMs)).toBe(false);
  });
});

describe('agent-login expiry in the standing attestation (WI-10003720)', () => {
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const logins = (claudeAt: string, codex: 'absent' | 'self-renewing' = 'absent'): WorkspaceHostAgentCredentialExpiryReading => ({
    kind: 'read',
    slots: [
      { slot: 'claude', kind: 'fixed', accessExpiresAt: claudeAt },
      codex === 'absent' ? { slot: 'codex', kind: 'absent' } : { slot: 'codex', kind: 'self-renewing', accessExpiresAt: null },
    ],
  });

  async function attest(script: HostScript) {
    const { runtime, recorded, agentLoginReads } = fakeRuntime([target('host-a')], { 'host-a': script });
    await runWorkspaceHostStandingHealthPass(runtime);
    return { attestation: recorded[0]!.attestation, agentLoginReads };
  }

  it('goes DEGRADED once a delivered login has expired, and names the agent', async () => {
    const { attestation } = await attest({ agentLogins: logins(at(-60_000), 'self-renewing') });
    expect(attestation.status).toBe('degraded');
    expect(attestation.checks.map((check) => [check.name, check.ok])).toEqual([
      ['compute-running', true],
      ['controller-reach', true],
      ['agent-credential:claude', false],
      ['agent-credential:codex', true],
    ]);
  });

  it('stays HEALTHY but flags amber while the login is inside the warning window', async () => {
    const { attestation } = await attest({ agentLogins: logins(at(30 * 60_000)) });
    expect(attestation.status).toBe('healthy');
    expect(attestation.checks.find((check) => check.name === 'agent-credential:claude')).toMatchObject({
      ok: true,
      warn: true,
    });
  });

  it('does not ask an UNREACHED host about its logins (the reach check already says why)', async () => {
    const { attestation, agentLoginReads } = await attest({
      reach: { kind: 'transport-failure', detail: 'ssh exited 255' },
      agentLogins: logins(at(-60_000)),
    });
    expect(agentLoginReads).toEqual([]);
    expect(attestation.checks.map((check) => check.name)).toEqual(['compute-running', 'controller-reach']);
  });

  it('a login read that throws is NOT MEASURED, never a silent pass', async () => {
    const { attestation } = await attest({ agentLogins: new Error('ssh exited 255') });
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks.at(-1)).toEqual({
      name: 'agent-credentials',
      ok: null,
      detail: 'not measured: ssh exited 255',
    });
  });
});

describe('spot reclaim recovery (WI-10005210)', () => {
  const spot = (status: string): WorkspaceHostSoakInstanceReading => ({
    kind: 'observed',
    status,
    instanceId: 'i-spot',
    sourceImage: IMAGE,
    preemptible: true,
  });

  function reclaimSeams(plan: Awaited<ReturnType<WorkspaceHostReclaimRestartSeams['prepare']>> | Error) {
    const prepared: { hostId: string; operationId: string }[] = [];
    const enqueued: { operationId: string; input: unknown }[] = [];
    const seams: WorkspaceHostReclaimRestartSeams = {
      prepare: async (t, operationId) => {
        prepared.push({ hostId: t.hostId, operationId });
        if (plan instanceof Error) throw plan;
        return plan;
      },
      enqueue: async (p) => {
        enqueued.push(p);
        return { kind: 'restart-enqueued', operationId: p.operationId };
      },
    };
    return { seams, prepared, enqueued };
  }

  it('flags only a STOPPED SPOT instance as reclaimed', () => {
    expect(workspaceHostSpotReclaimed(spot('TERMINATED'))).toBe(true);
    // EC2's stopped, as the AWS soak reading reports it (upper-cased; WI-10005389).
    expect(workspaceHostSpotReclaimed(spot('STOPPED'))).toBe(true);
    expect(workspaceHostSpotReclaimed(spot('RUNNING'))).toBe(false);
    expect(workspaceHostSpotReclaimed(spot('STOPPING'))).toBe(false);
    // An on-demand host the cloud reports stopped is NOT restarted: nothing reclaims on-demand VMs.
    expect(workspaceHostSpotReclaimed({ kind: 'observed', status: 'TERMINATED', instanceId: 'i-1' })).toBe(false);
    expect(workspaceHostSpotReclaimed({ kind: 'absent' })).toBe(false);
    expect(workspaceHostSpotReclaimed({ kind: 'unreadable', detail: 'x' })).toBe(false);
  });

  it('attests a reclaimed spot host with a failing spot-reclaimed check and no IAP reach', async () => {
    const { runtime, reachSubjects } = fakeRuntime([], { h: { reading: spot('TERMINATED') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unreachable');
    expect(attestation.checks).toEqual([
      { name: 'compute-running', ok: false, detail: 'TERMINATED' },
      {
        name: WORKSPACE_HOST_SPOT_RECLAIMED_CHECK,
        ok: false,
        detail: 'spot instance is TERMINATED: the cloud reclaimed it while the host is meant to run',
      },
      { name: 'controller-reach', ok: null, detail: 'not attempted: the instance is TERMINATED, not RUNNING' },
    ]);
    expect(reachSubjects).toEqual([]);
  });

  it('a RUNNING spot host carries no reclaim check (no vacuous checks)', async () => {
    const { runtime } = fakeRuntime([], { h: { reading: spot('RUNNING') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.checks.map((c) => c.name)).not.toContain(WORKSPACE_HOST_SPOT_RECLAIMED_CHECK);
  });

  it('restarts only the reclaimed host, with a replay-stable operation id, after recording its health', async () => {
    const { runtime, steps, recorded } = fakeRuntime([target('spot-down'), target('fine'), target('ondemand-down')], {
      'spot-down': { reading: spot('TERMINATED') },
      'ondemand-down': { reading: { kind: 'observed', status: 'TERMINATED', instanceId: 'i-od' } },
    });
    const { seams, prepared, enqueued } = reclaimSeams({ kind: 'restart', operationId: 'op-x', input: { action: 'start' } });
    runtime.reclaim = seams;

    const result = await runWorkspaceHostStandingHealthPass(runtime);

    const expectedOp = workspaceHostReclaimOperationId({ workspaceId: WS, hostId: 'spot-down' }, NOW.getTime());
    expect(expectedOp).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(workspaceHostReclaimOperationId({ workspaceId: WS, hostId: 'spot-down' }, NOW.getTime())).toBe(expectedOp);
    expect(workspaceHostReclaimOperationId({ workspaceId: WS, hostId: 'spot-down' }, NOW.getTime() + 1)).not.toBe(expectedOp);
    expect(prepared).toEqual([{ hostId: 'spot-down', operationId: expectedOp }]);
    expect(enqueued).toEqual([{ operationId: 'op-x', input: { action: 'start' } }]);
    // The prepare runs in its own checkpointed step, after the host's attestation step.
    expect(steps).toEqual([
      'standing-health-list',
      `standing-health-host:${WS}:spot-down`,
      `standing-health-reclaim:${WS}:spot-down`,
      `standing-health-host:${WS}:fine`,
      `standing-health-host:${WS}:ondemand-down`,
    ]);
    expect(recorded.map((r) => r.attestation.hostId)).toEqual(['spot-down', 'fine', 'ondemand-down']);
    const byHost = Object.fromEntries(
      result.outcomes.map((o) => [o.hostId, o.kind === 'attested' ? o.recovery : 'not-attested']),
    );
    expect(byHost).toEqual({
      'spot-down': { kind: 'restart-enqueued', operationId: 'op-x' },
      fine: undefined,
      'ondemand-down': undefined,
    });
  });

  it('reports a skipped restart with its reason and enqueues nothing', async () => {
    const { runtime } = fakeRuntime([target('h')], { h: { reading: spot('TERMINATED') } });
    const { seams, enqueued } = reclaimSeams({ kind: 'skip', reason: "desired state is now 'stopped'" });
    runtime.reclaim = seams;
    const result = await runWorkspaceHostStandingHealthPass(runtime);
    expect(enqueued).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({
      kind: 'attested',
      recovery: { kind: 'restart-skipped', reason: "desired state is now 'stopped'" },
    });
  });

  it('a prepare or enqueue that throws is a reported restart failure, and the pass keeps going', async () => {
    const { runtime } = fakeRuntime([target('a'), target('b')], {
      a: { reading: spot('TERMINATED') },
      b: { reading: spot('TERMINATED') },
    });
    let calls = 0;
    runtime.reclaim = {
      prepare: async (t, operationId) => {
        if (t.hostId === 'a') throw new Error('connection closed');
        return { kind: 'restart', operationId, input: {} };
      },
      enqueue: async () => {
        calls += 1;
        throw new Error('queue unavailable');
      },
    };
    const result = await runWorkspaceHostStandingHealthPass(runtime);
    expect(calls).toBe(1);
    expect(result.outcomes.map((o) => (o.kind === 'attested' ? o.recovery : undefined))).toEqual([
      { kind: 'restart-failed', error: 'could not prepare the restart: connection closed' },
      { kind: 'restart-failed', error: 'queue unavailable' },
    ]);
  });

  it('without reclaim seams a reclaimed host is still attested, just not restarted', async () => {
    const { runtime, steps } = fakeRuntime([target('h')], { h: { reading: spot('TERMINATED') } });
    const result = await runWorkspaceHostStandingHealthPass(runtime);
    expect(steps).toEqual(['standing-health-list', `standing-health-host:${WS}:h`]);
    expect(result.outcomes[0]).toMatchObject({ kind: 'attested', status: 'unreachable' });
    expect(result.outcomes[0]).not.toHaveProperty('recovery');
  });

  describe('the 2-minute spot-reclaim sweep (D-028)', () => {
    function sweep(spotHosts: string[], hosts: Record<string, HostScript>) {
      const base = fakeRuntime([], hosts);
      const reclaim = reclaimSeams({ kind: 'restart', operationId: 'op-sweep', input: { action: 'start' } });
      const runtime: WorkspaceHostSpotReclaimSweepRuntime = {
        step: base.runtime.step,
        controllerId: CONTROLLER,
        listSpotTargets: async (controllerId) => {
          expect(controllerId).toBe(CONTROLLER);
          return spotHosts.map((hostId) => ({ workspaceId: WS, hostId }));
        },
        resolveSeams: base.runtime.resolveSeams,
        recordHealth: base.runtime.recordHealth,
        now: base.runtime.now,
        reclaim: reclaim.seams,
      };
      return { ...base, runtime, prepared: reclaim.prepared, enqueued: reclaim.enqueued };
    }

    it('costs one provider read for a spot host that is up: no IAP reach, no health write, no restart', async () => {
      const { runtime, steps, recorded, reachSubjects, prepared } = sweep(['up'], { up: { reading: spot('RUNNING') } });
      const result = await runWorkspaceHostSpotReclaimSweep(runtime);
      expect(steps).toEqual(['spot-reclaim-list', `spot-reclaim-read:${WS}:up`]);
      expect(recorded).toEqual([]);
      expect(reachSubjects).toEqual([]);
      expect(prepared).toEqual([]);
      expect(result).toEqual({
        controllerId: CONTROLLER,
        outcomes: [{ kind: 'not-reclaimed', workspaceId: WS, hostId: 'up', status: 'RUNNING' }],
      });
    });

    it('attests and restarts a reclaimed host through the standing pass steps and operation id, without an IAP reach', async () => {
      const { runtime, steps, recorded, reachSubjects, prepared, enqueued } = sweep(['down', 'up'], {
        down: { reading: spot('TERMINATED') },
        up: { reading: spot('RUNNING') },
      });
      const result = await runWorkspaceHostSpotReclaimSweep(runtime);
      expect(steps).toEqual([
        'spot-reclaim-list',
        `spot-reclaim-read:${WS}:down`,
        `standing-health-host:${WS}:down`,
        `standing-health-reclaim:${WS}:down`,
        `spot-reclaim-read:${WS}:up`,
      ]);
      expect(reachSubjects).toEqual([]);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.attestation).toMatchObject({ hostId: 'down', status: 'unreachable' });
      expect(recorded[0]!.attestation.checks).toContainEqual(
        expect.objectContaining({ name: WORKSPACE_HOST_SPOT_RECLAIMED_CHECK, ok: false }),
      );
      expect(prepared).toEqual([
        { hostId: 'down', operationId: workspaceHostReclaimOperationId({ workspaceId: WS, hostId: 'down' }, NOW.getTime()) },
      ]);
      expect(enqueued).toEqual([{ operationId: 'op-sweep', input: { action: 'start' } }]);
      expect(result.outcomes[0]).toMatchObject({
        kind: 'attested',
        hostId: 'down',
        recovery: { kind: 'restart-enqueued', operationId: 'op-sweep' },
      });
    });

    it('leaves an absent or unreadable spot host to the standing pass instead of attesting it every 2 minutes', async () => {
      const { runtime, recorded, prepared } = sweep(['gone', 'blind', 'unresolved'], {
        gone: { reading: { kind: 'absent' } },
        blind: { reading: new Error('403 compute.instances.get denied') },
        unresolved: { seamsError: new Error('gcp_workspace_host_hosted_connection_missing') },
      });
      const result = await runWorkspaceHostSpotReclaimSweep(runtime);
      expect(recorded).toEqual([]);
      expect(prepared).toEqual([]);
      expect(result.outcomes).toEqual([
        { kind: 'not-reclaimed', workspaceId: WS, hostId: 'gone', status: 'absent' },
        { kind: 'unread', workspaceId: WS, hostId: 'blind', detail: '403 compute.instances.get denied' },
        { kind: 'unread', workspaceId: WS, hostId: 'unresolved', detail: 'gcp_workspace_host_hosted_connection_missing' },
      ]);
    });

    it("the sweep's attestation is fresh at the next standing pass, so the pass does not attest or restart the host again", async () => {
      const { runtime, recorded } = sweep(['down'], { down: { reading: spot('TERMINATED') } });
      await runWorkspaceHostSpotReclaimSweep(runtime);
      const attestedAt = recorded[0]!.attestation.observedAt;
      // The next standing pass, at most one sweep interval later, lists the host with that timestamp.
      const nextPassMs = NOW.getTime() + 2 * 60_000;
      expect(workspaceHostStandingHealthIsFresh(target('down', attestedAt), nextPassMs)).toBe(true);
      const standing = fakeRuntime([target('down', attestedAt)], { down: { reading: spot('TERMINATED') } });
      standing.runtime.now = () => new Date(nextPassMs);
      const reclaim = reclaimSeams({ kind: 'restart', operationId: 'op-standing', input: {} });
      standing.runtime.reclaim = reclaim.seams;
      const result = await runWorkspaceHostStandingHealthPass(standing.runtime);
      expect(result.outcomes).toEqual([{ kind: 'skipped-fresh', workspaceId: WS, hostId: 'down', attestedAt }]);
      expect(reclaim.prepared).toEqual([]);
    });
  });
});
