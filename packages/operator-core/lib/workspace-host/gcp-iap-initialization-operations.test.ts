import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  ReplaySafeWorkspaceHostInitializationExecutor,
  DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS,
  encodeWorkspaceHostCredentialLifecycleStep,
  parseWorkspaceHostRemoteInitializerRequest,
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';
import {
  DEFAULT_GCP_IAP_INITIALIZATION_TIMEOUT_MS,
  GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
  GcpIapWorkspaceHostBootstrapFailedError,
  GcpIapWorkspaceHostBootstrapNotReadyError,
  GcpIapWorkspaceHostInitializationOperations,
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  buildGcpIapWorkspaceHostBootstrapReadinessProbe,
  buildGcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostInitializationProfile,
} from './gcp-iap-initialization-operations';

const PROFILE: GcpIapWorkspaceHostInitializationProfile = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  instanceName: 'pc-workspace-1',
  instanceId: '4715512353118305137',
  sshUser: 'papercusp-workspace',
  knownHostsFile: '/var/lib/papercusp/controller/known_hosts',
  identityFile: '/var/lib/papercusp/controller/os-login',
  remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
};

const REFS: WorkspaceHostCredentialRefs = {
  cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
  gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
  agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
};

const DELIVERY: WorkspaceHostCredentialDeliverySet = {
  cloud: {
    kind: 'provider-identity',
    generation: 1,
    audience: 'host-1',
    revocationRef: 'revoke-cloud-v1',
  },
  git: {
    kind: 'forwarded-agent',
    generation: 1,
    audience: 'host-1',
    revocationRef: 'revoke-git-v1',
  },
  agent: {
    kind: 'short-lived-delegation',
    generation: 1,
    audience: 'host-1',
    revocationRef: 'revoke-agent-v1',
    expiresAt: '2026-08-23T07:00:00Z',
  },
};

function step() {
  return planWorkspaceHostInitialization({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: 'init-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    requestedAt: '2026-08-23T06:00:00Z',
    deliveryCapabilities: { fileTransfer: true },
    source: { kind: 'empty' },
    credentialRefs: REFS,
    credentialDelivery: DELIVERY,
  }).steps[0]!;
}

function lifecycleStep() {
  return planWorkspaceHostCredentialLifecycle({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: 'revoke-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    requestedAt: '2026-08-23T06:00:00Z',
    deliveryCapabilities: { fileTransfer: true },
    action: 'revoke',
    currentCredentialRefs: REFS,
    currentDelivery: DELIVERY,
    channels: ['git'],
  }).steps[0]!;
}

describe('GCP IAP workspace-host initialization operations', () => {
  it('plans one strict non-interactive OpenSSH/IAP request without bash, scp, or credential bytes', () => {
    const command = buildGcpIapWorkspaceHostInitializationCommand(PROFILE, step());

    expect(command.command).toBe('ssh');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '-T',
        'BatchMode=yes',
        'ClearAllForwardings=yes',
        'StrictHostKeyChecking=yes',
        `UserKnownHostsFile=${PROFILE.knownHostsFile}`,
        `ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=${PROFILE.projectId} --zone=${PROFILE.zone} --verbosity=error`,
        `${PROFILE.sshUser}@${PROFILE.instanceName}`,
      ]),
    );
    expect(command.args.at(-1)).toContain("'/opt/papercusp/current/bin/papercusp-workspace-initialize'");
    expect(command.args.join(' ')).not.toMatch(/\b(?:bash|scp)\b/);
    expect(JSON.parse(command.stdin)).toMatchObject({
      protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
      step: { id: 'workspace', kind: 'create-workspace' },
    });
    expect(command.stdin).not.toMatch(/PRIVATE KEY|access.?token|api.?key/i);
  });

  it('declares every typed step capability and performs no I/O until execute', async () => {
    const run = vi.fn<GcpIapWorkspaceHostInitializationCommandRunner['run']>().mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
        stepId: 'workspace',
        status: 'succeeded',
        observedAt: '2026-08-23T06:01:00Z',
        publicEvidence: { workspaceCreated: true },
      }),
    });
    const operations = new GcpIapWorkspaceHostInitializationOperations(PROFILE, { run });

    expect(operations.supportedStepKinds).toEqual(WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS.filter(
      (kind) => kind !== 'install-desktop-pack',
    ));
    expect(run).not.toHaveBeenCalled();
    expect(() => new ReplaySafeWorkspaceHostInitializationExecutor({
      operations,
      replayStore: { runOnce: async (_identity, execute) => execute() },
    })).not.toThrow();
    await expect(operations.execute(step())).resolves.toEqual({
      observedAt: '2026-08-23T06:01:00Z',
      publicEvidence: { workspaceCreated: true },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('carries optional desktop installation over the fixed initializer conduit', async () => {
    const desktopStep = {
      id: 'desktop-pack', kind: 'install-desktop-pack' as const, dependsOn: [],
      idempotencyKey: 'host-1-desktop-pack', input: { hostId: 'host-1' },
    };
    const run = vi.fn<GcpIapWorkspaceHostInitializationCommandRunner['run']>().mockResolvedValue({
      exitCode: 0, stderr: '', stdout: JSON.stringify({
        protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
        stepId: desktopStep.id, status: 'succeeded', observedAt: '2026-08-23T06:01:00Z',
        publicEvidence: { hostId: 'host-1', action: 'install' },
      }),
    });
    const operations = new GcpIapWorkspaceHostInitializationOperations(PROFILE, { run });
    await expect(operations.execute(desktopStep)).resolves.toMatchObject({
      publicEvidence: { hostId: 'host-1', action: 'install' },
    });
    const command = run.mock.calls[0][0];
    expect(parseWorkspaceHostRemoteInitializerRequest(JSON.parse(command.stdin)).step).toEqual(desktopStep);
    expect(command.command).toBe('ssh');
    expect(command.args.join(' ')).not.toMatch(/\b(?:bash|scp)\b/);
  });

  it('round-trips a planner-produced credential-lifecycle step through the command builder', () => {
    const planned = lifecycleStep();
    const command = buildGcpIapWorkspaceHostInitializationCommand(PROFILE, planned);
    const request = parseWorkspaceHostRemoteInitializerRequest(JSON.parse(command.stdin));

    expect(request.step).toEqual(encodeWorkspaceHostCredentialLifecycleStep(planned));
    expect(request.step).toMatchObject({
      id: 'revoke-git',
      kind: 'revoke',
      input: {
        channel: 'git',
        credentialRef: REFS.gitCredentialRef,
        delivery: DELIVERY.git,
      },
    });
    expect(request.step).not.toHaveProperty('channel');
  });

  it('fails closed on routing injection before invoking the transport', async () => {
    const run = vi.fn<GcpIapWorkspaceHostInitializationCommandRunner['run']>();
    const operations = new GcpIapWorkspaceHostInitializationOperations(
      { ...PROFILE, zone: 'us-central1-a; touch /tmp/pwned' },
      { run },
    );

    await expect(operations.execute(step())).rejects.toThrow('GCP zone has an invalid value');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects secret-shaped remote evidence and never reflects transport output in an exit error', async () => {
    const secretResponse = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
            stepId: 'workspace',
            status: 'succeeded',
            observedAt: '2026-08-23T06:01:00Z',
            publicEvidence: { accessToken: 'must-never-persist' },
          }),
        };
      },
    });
    await expect(secretResponse.execute(step())).rejects.toThrow(/Secret-shaped field/);

    const failed = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return { exitCode: 23, stdout: 'private diagnostic must not escape', stderr: '' };
      },
    });
    await expect(failed.execute(step())).rejects.toThrow('failed with exit code 23');
    await expect(failed.execute(step())).rejects.not.toThrow(/private diagnostic/);
  });

  it('refuses a controller profile with no identity file instead of connecting as whatever default key the process owns', () => {
    // Live failure on the P-318 r38 canary (2026-09-22). PROVISION bakes ${identityFile}.pub
    // into the host's authorized_keys and REFUSES to render a bootstrap without one
    // (provision-bootstrap.ts), because harden-os then locks the host to publickey-only for
    // an account with no key (D-238). This CONNECT side used to drop `-i` silently when the
    // controller had no identityFile, so ssh fell back to the operator process's default key —
    // which, with IdentitiesOnly pinned below, can never be the key the host authorized.
    // Result: 74/74 probes "Permission denied (publickey)" over 1199s, reported as a GUEST
    // bootstrap timeout while the guest was in fact healthy. The two halves must agree, so a
    // profile with no identity is refused here rather than producing a doomed command.
    const { identityFile: _omitted, ...withoutIdentity } = PROFILE;
    expect(() => buildGcpIapWorkspaceHostInitializationCommand(withoutIdentity, step())).toThrow(
      /PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE/,
    );
    // An empty/whitespace value is the same misconfiguration wearing a different shape.
    expect(() =>
      buildGcpIapWorkspaceHostInitializationCommand({ ...PROFILE, identityFile: '   ' }, step()),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE/);
  });

  it('pins IdentitiesOnly alongside the controller identity, so ambient agent keys cannot exhaust MaxAuthTries', () => {
    // Live failure on p046-canary-02: the operator's ssh-agent held 7 keys, sshd's default
    // MaxAuthTries is 6, so the connection was disconnected with "Too many authentication
    // failures" before the correct credential was offered — surfacing only as exit 255.
    // IdentitiesOnly must therefore be pinned on EVERY command this builder produces, never
    // made conditional on some other field being present.
    const withIdentity = buildGcpIapWorkspaceHostInitializationCommand(PROFILE, step());
    expect(withIdentity.args).toContain('IdentitiesOnly=yes');
    expect(withIdentity.args).toContain('-i');
    expect(withIdentity.args).toContain('/var/lib/papercusp/controller/os-login');
    // The pin must precede the identity it constrains, or OpenSSH has already offered
    // agent keys by the time it is applied.
    expect(withIdentity.args.indexOf('IdentitiesOnly=yes')).toBeLessThan(
      withIdentity.args.indexOf('-i'),
    );
  });

  it('surfaces the transport stderr tail on a non-zero exit so the failure is diagnosable', async () => {
    const failed = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return {
          exitCode: 255,
          stdout: '',
          stderr: 'ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4033: not authorized].',
        };
      },
    });
    // The bare exit code spans auth, tunnel, firewall and IAP-permission failures.
    // Without the stderr tail every one of them is indistinguishable.
    await expect(failed.execute(step())).rejects.toThrow(/4033: not authorized/);
    await expect(failed.execute(step())).rejects.toThrow(/failed with exit code 255/);
  });

  it('redacts secrets in the surfaced stderr tail', async () => {
    const failed = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'curl failed: Authorization: Bearer ya29.super-secret-token (tunnel closed)',
        };
      },
    });
    await expect(failed.execute(step())).rejects.toThrow(/tunnel closed/);
    await expect(failed.execute(step())).rejects.not.toThrow(/ya29\.super-secret-token/);
  });

  it('degrades to the bare exit code when the runner reports no stderr', async () => {
    const failed = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        // A runner that omits stderr must not make the formatter throw and replace
        // the real failure with its own.
        return { exitCode: 7, stdout: '' } as never;
      },
    });
    await expect(failed.execute(step())).rejects.toThrow('failed with exit code 7');
  });

  it('keeps the outer IAP timeout beyond the complete legal sequential agent-probe path', () => {
    const legalSequentialProbeBudgetMs = Object.values(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
    )
      .flat()
      .reduce(
        (total, probe) =>
          total + (probe.timeoutMs ?? DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS),
        0,
      );

    expect(DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS).toBe(
      legalSequentialProbeBudgetMs,
    );
    expect(DEFAULT_GCP_IAP_INITIALIZATION_TIMEOUT_MS).toBeGreaterThan(
      legalSequentialProbeBudgetMs,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'kills the local SSH and proxy process group when the outer IAP timeout expires',
    async () => {
      let child: ChildProcess | undefined;
      let descendantPid: number | undefined;
      let closed: Promise<unknown> | undefined;
      const spawnProbe: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
        child = nodeSpawn(...args);
        closed = once(child, 'close');
        child.stdout?.on('data', (chunk: Buffer) => {
          const match = /DESCENDANT_PID=(\d+)/.exec(chunk.toString());
          if (match) descendantPid = Number(match[1]);
        });
        return child;
      }) as typeof nodeSpawn;
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
        "console.log('DESCENDANT_PID=' + child.pid);",
        'setTimeout(() => {}, 30000);',
      ].join('\n');

      try {
        await expect(
          new NodeGcpIapWorkspaceHostInitializationCommandRunner({
            spawn: spawnProbe,
            timeoutMs: 2_000,
          }).run({
            command: process.execPath,
            args: ['-e', script],
            stdin: '',
          }),
        ).rejects.toThrow(/timed out/);
        expect(descendantPid).toBeGreaterThan(0);
        // `close`, unlike `exit`, waits for the descendant's inherited pipes too. Without the
        // process-group kill the descendant holds them for its full 30s, so any window well
        // under 30s separates fixed from broken; a 1s window was a load race (WI-10003860).
        expect(
          await Promise.race([closed!.then(() => true), delay(10_000, false)]),
        ).toBe(true);
      } finally {
        // Also clean up the intentionally red pre-fix reproduction.
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Already reaped by the fixed process-group cleanup.
          }
        }
        child?.kill('SIGKILL');
        await closed;
      }
    },
    15_000,
  );
});

/**
 * WI-10001677. The gate exists to separate three outcomes an `exit 127` used to collapse into
 * one, so every test here is about which outcome is reported — not merely that waiting happens.
 */
describe('GCP IAP workspace-host bootstrap readiness gate', () => {
  /** Scripted runner: one queued exit code per probe, and it records every command it ran. */
  const scriptedRunner = (
    exitCodes: readonly number[],
    stderr = '',
  ): GcpIapWorkspaceHostInitializationCommandRunner & {
    commands: GcpIapWorkspaceHostInitializationCommand[];
  } => {
    const commands: GcpIapWorkspaceHostInitializationCommand[] = [];
    let index = 0;
    return {
      commands,
      async run(command) {
        commands.push(command);
        // Past the script, keep answering with the final code: a test asserting a TIMEOUT must not
        // depend on having guessed the exact probe count.
        const exitCode = exitCodes[Math.min(index, exitCodes.length - 1)] ?? 1;
        index += 1;
        return { exitCode, stdout: '', stderr };
      },
    };
  };

  /** Virtual clock: advances only when the gate sleeps, so a 20-minute budget costs no wall time. */
  const virtualTiming = () => {
    let clock = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    };
  };

  it('probes the conduit with `test -x` and never invokes the conduit itself', () => {
    const probe = buildGcpIapWorkspaceHostBootstrapReadinessProbe(PROFILE);
    const remote = probe.args.at(-1) ?? '';

    expect(remote).toContain('/bin/test');
    expect(remote).toContain('-x');
    expect(remote).toContain(PROFILE.remoteEntrypoint);
    // The probe must be side-effect free: the conduit speaks a JSON protocol, and a "harmless"
        // call to it would be a real request whose failures overlap the ones we are separating.
    expect(probe.stdin).toBe('');
    expect(remote.startsWith(PROFILE.remoteEntrypoint)).toBe(false);
  });

  it('returns readyImmediately when the first probe finds the conduit, without sleeping', async () => {
    const runner = scriptedRunner([0]);
    const timing = virtualTiming();
    const onWaiting = vi.fn();

    const result = await new GcpIapWorkspaceHostInitializationOperations(
      PROFILE,
      runner,
      timing,
    ).awaitBootstrapReady({ onWaiting });

    expect(result).toMatchObject({ probes: 1, readyImmediately: true, waitedMs: 0 });
    expect(timing.slept).toEqual([]);
    // No waiting happened, so nothing should have reported waiting.
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('waits through not-ready answers and reports how long the race actually took', async () => {
    const runner = scriptedRunner([1, 1, 0]);
    const timing = virtualTiming();
    const onWaiting = vi.fn();

    const result = await new GcpIapWorkspaceHostInitializationOperations(
      PROFILE,
      runner,
      timing,
    ).awaitBootstrapReady({ pollIntervalMs: 15_000, timeoutMs: 600_000, onWaiting });

    expect(result).toMatchObject({ probes: 3, readyImmediately: false, waitedMs: 30_000 });
    expect(timing.slept).toEqual([15_000, 15_000]);
    // Progress must be reported per wait, or the gate is indistinguishable from a hang to
    // anyone reading the operation row.
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(onWaiting).toHaveBeenLastCalledWith({
      elapsedMs: 15_000,
      timeoutMs: 600_000,
      probes: 2,
    });
  });

  it('on timeout after clean answers, blames the unfinished bootstrap', async () => {
    const runner = scriptedRunner([1]);
    const timing = virtualTiming();

    const error = await new GcpIapWorkspaceHostInitializationOperations(PROFILE, runner, timing)
      .awaitBootstrapReady({ pollIntervalMs: 10_000, timeoutMs: 60_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GcpIapWorkspaceHostBootstrapNotReadyError);
    const notReady = error as GcpIapWorkspaceHostBootstrapNotReadyError;
    expect(notReady.answered).toBe(true);
    expect(notReady.conduitPath).toBe(PROFILE.remoteEntrypoint);
    expect(notReady.message).toContain('bootstrap');
    expect(notReady.message).toContain(PROFILE.remoteEntrypoint);
    // Never sleeps past its own deadline.
    expect(notReady.waitedMs).toBeLessThan(60_000);
  });

  it('on a budget spent entirely on transport failures, reports transport — NOT a slow bootstrap', async () => {
    // 255 is ssh's catch-all: auth, tunnel, IAP permission and firewall all land here, and the
    // conduit is never actually examined. Reporting this as "bootstrap was slow" would replace a
    // loud misconfiguration with a twenty-minute lie.
    const runner = scriptedRunner([255], 'Permission denied (publickey).');
    const timing = virtualTiming();

    const error = await new GcpIapWorkspaceHostInitializationOperations(PROFILE, runner, timing)
      .awaitBootstrapReady({ pollIntervalMs: 10_000, timeoutMs: 60_000 })
      .catch((caught: unknown) => caught);

    const notReady = error as GcpIapWorkspaceHostBootstrapNotReadyError;
    expect(notReady).toBeInstanceOf(GcpIapWorkspaceHostBootstrapNotReadyError);
    expect(notReady.answered).toBe(false);
    expect(notReady.lastExitCode).toBe(255);
    expect(notReady.message).toContain('never actually checked');
    expect(notReady.message).toContain('Permission denied');
  });

  it('still takes one real observation when the budget is shorter than one poll interval', async () => {
    // A budget smaller than the interval must not degrade into zero measurements — a gate that
    // reports "not ready" without ever having asked is the false negative this whole change exists
    // to remove, just relocated into the gate itself.
    const runner = scriptedRunner([0]);
    const timing = virtualTiming();

    const result = await new GcpIapWorkspaceHostInitializationOperations(
      PROFILE,
      runner,
      timing,
    ).awaitBootstrapReady({ pollIntervalMs: 30_000, timeoutMs: 1_000 });

    expect(result.probes).toBe(1);
    expect(runner.commands).toHaveLength(1);
  });

  it('fails immediately when the controller lacks the AWS Session Manager plugin', async () => {
    const runner = scriptedRunner([255], 'aws: [ERROR]: SessionManagerPlugin is not found.');
    const timing = virtualTiming();
    const onWaiting = vi.fn();
    const bootstrapStatus = vi.fn(async () => ({ state: 'succeeded' as const }));

    await expect(new GcpIapWorkspaceHostInitializationOperations(PROFILE, runner, timing, bootstrapStatus)
      .awaitBootstrapReady({ timeoutMs: 1_200_000, onWaiting }))
      .rejects.toThrow('AWS Session Manager plugin on the controller');

    expect(runner.commands).toHaveLength(1);
    expect(timing.slept).toEqual([]);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(bootstrapStatus).not.toHaveBeenCalled();
  });

  it('fails fast on the bootstrap reporting failure, instead of waiting out the budget (WI-10002837)', async () => {
    // A host that died in harden-os never authorizes the controller key, so every probe is a 255.
    const runner = scriptedRunner([255], 'Permission denied (publickey).');
    const timing = virtualTiming();
    const reports = [
      { state: 'running' as const },
      { state: 'failed' as const, exitCode: 100, phase: 'harden-os', error: 'apt-get install failed' },
    ];
    const bootstrapStatus = vi.fn(async () => reports.shift() ?? null);

    const error = await new GcpIapWorkspaceHostInitializationOperations(PROFILE, runner, timing, bootstrapStatus)
      .awaitBootstrapReady({ pollIntervalMs: 10_000, timeoutMs: 1_200_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GcpIapWorkspaceHostBootstrapFailedError);
    const failed = error as GcpIapWorkspaceHostBootstrapFailedError;
    expect(failed).toMatchObject({ exitCode: 100, phase: 'harden-os', probes: 2, waitedMs: 10_000 });
    expect(failed.message).toContain('harden-os');
    expect(failed.message).toContain('apt-get install failed');
    expect(timing.slept).toEqual([10_000]);
  });

  it('keeps the probe as the authority: running, succeeded and unreadable reports never end the wait', async () => {
    const runner = scriptedRunner([1, 1, 1, 0]);
    const timing = virtualTiming();
    const reports: Array<() => Promise<unknown>> = [
      async () => ({ state: 'running' }),
      async () => {
        throw new Error('compute 503');
      },
      async () => ({ state: 'succeeded' }),
    ];
    const bootstrapStatus = vi.fn(() => (reports.shift() ?? (async () => null))()) as never;

    const result = await new GcpIapWorkspaceHostInitializationOperations(PROFILE, runner, timing, bootstrapStatus)
      .awaitBootstrapReady({ pollIntervalMs: 10_000, timeoutMs: 600_000 });

    expect(result).toMatchObject({ probes: 4, readyImmediately: false });
    // Read once per MISSED probe, never after the one that found the conduit.
    expect(bootstrapStatus).toHaveBeenCalledTimes(3);
  });

  it('does not read the report at all when the first probe finds the conduit', async () => {
    const bootstrapStatus = vi.fn(async () => null);

    await new GcpIapWorkspaceHostInitializationOperations(
      PROFILE,
      scriptedRunner([0]),
      virtualTiming(),
      bootstrapStatus,
    ).awaitBootstrapReady();

    expect(bootstrapStatus).not.toHaveBeenCalled();
  });
});
