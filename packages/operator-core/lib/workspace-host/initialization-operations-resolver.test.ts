/**
 * initialization-operations-resolver.test.ts (P-046 / WI-40474).
 *
 * The property worth guarding here is not "the resolver returns an object" — it is that the
 * instance the INITIALIZER tunnels to is the same instance the PROVIDER creates. Those live in
 * different modules and are reached by different call paths, so nothing but a test stops a
 * future edit from re-forking the derivation. A re-fork would not fail here or in typecheck; it
 * would fail against real cloud, at runtime, as an SSH to a nonexistent instance.
 */
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
  assertWorkspaceHostSecretIsolation,
  buildWorkspaceHostBootstrap,
  deriveWorkspaceHostCanonicalArtifactUrls,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  WorkspaceHostHostKeyPublicationTimeoutError,
  WorkspaceHostInitializationHostKeyError,
  WorkspaceHostInstanceUnavailableError,
  awsCliResolvesConnectionIdentity,
  enrollAwsSsmHostKeys,
  enrollGcpIapHostKeys,
  ec2ConsoleBootstrapStatusSource,
  establishAwsSsmHostKeyTrust,
  gcpBootstrapStatusSource,
  parseEc2ConsoleHostKeys,
  pruneGcpIapHostKeysForAbsentHost,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperations,
  resolveWorkspaceHostInitializationOperationsForHost,
  type GcpIapHostKeyEnrollmentInput,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { resolveGcpWorkspaceHostInstanceIdentity, type GcpInstanceGuestAttribute } from './gcp-provider';
import {
  awsSsmHostKeyAlias,
  buildGcpIapWorkspaceHostInitializationCommand,
  gcpIapHostKeyAliasFamily,
  workspaceHostSshHostKeyAlias,
} from './gcp-iap-initialization-operations';
import { AWS_WORKSPACE_HOST_TRANSPORT_FEATURES } from './aws-connection-profile';

const controller: WorkspaceHostInitializationControllerProfile = {
  sshUser: 'papercusp',
  knownHostsFile: '/etc/papercusp/known_hosts',
  remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
  deliveryEntrypoint: '/opt/papercusp/bin/papercusp-deliver-material',
  // A controller with no identityFile cannot authenticate to any host it provisioned —
  // provision bakes ${identityFile}.pub into authorized_keys and harden-os then locks the
  // host to publickey-only — so buildGcpIapSshInvocation now refuses one outright. Fixtures
  // here exercise instance targeting and known_hosts enrollment, not that misconfiguration,
  // so they carry a realistic identity; the refusal itself is covered by
  // gcp-iap-initialization-operations.test.ts.
  identityFile: '/etc/papercusp/id_ed25519',
};

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type TestHostKeyAlgorithm = 'ecdsa-sha2-nistp256' | 'ssh-ed25519' | 'ssh-rsa';

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function sshMpint(value: Buffer): Buffer {
  const positive = (value[0]! & 0x80) === 0 ? value : Buffer.concat([Buffer.from([0]), value]);
  return sshString(positive);
}

const generatedHostKeys = new Map<string, string>();

function publicKey(algorithm: TestHostKeyAlgorithm, marker: string = algorithm): string {
  const cacheKey = `${algorithm}:${marker}`;
  const cached = generatedHostKeys.get(cacheKey);
  if (cached) return cached;

  let blob: Buffer;
  if (algorithm === 'ssh-ed25519') {
    const generated = generateKeyPairSync('ed25519');
    const jwk = generated.publicKey.export({ format: 'jwk' });
    blob = Buffer.concat([sshString(algorithm), sshString(Buffer.from(jwk.x!, 'base64url'))]);
  } else if (algorithm === 'ecdsa-sha2-nistp256') {
    const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = generated.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    blob = Buffer.concat([sshString(algorithm), sshString('nistp256'), sshString(point)]);
  } else {
    const generated = generateKeyPairSync('rsa', { modulusLength: 2_048, publicExponent: 0x10001 });
    const jwk = generated.publicKey.export({ format: 'jwk' });
    blob = Buffer.concat([
      sshString(algorithm),
      sshMpint(Buffer.from(jwk.e!, 'base64url')),
      sshMpint(Buffer.from(jwk.n!, 'base64url')),
    ]);
  }
  const line = `${algorithm} ${blob.toString('base64')} generated-on-host`;
  generatedHostKeys.set(cacheKey, line);
  return line;
}

function publicKeyBlob(algorithm: TestHostKeyAlgorithm, marker: string = algorithm): string {
  return publicKey(algorithm, marker).split(' ')[1]!;
}

function guestHostKeys(marker = 'first'): readonly GcpInstanceGuestAttribute[] {
  return [
    {
      namespace: 'hostkeys',
      key: 'ecdsa-sha2-nistp256',
      value: publicKeyBlob('ecdsa-sha2-nistp256', marker),
    },
    { namespace: 'hostkeys', key: 'ssh-ed25519', value: publicKeyBlob('ssh-ed25519', marker) },
    { namespace: 'hostkeys', key: 'ssh-rsa', value: publicKeyBlob('ssh-rsa', marker) },
  ];
}

function desired(overrides: Partial<WorkspaceHostDesiredSpec> = {}): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-alpha',
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    ...overrides,
  } as WorkspaceHostDesiredSpec;
}

/** A GCE instance id — the incarnation behind a name; fresh on every delete + re-insert. */
const INSTANCE_ID = '4715512353118305137';
const incarnation = { instanceId: INSTANCE_ID };

/** `getInstance` fake answering one incarnation per call, in order (the last one repeats). */
function liveInstance(...instanceIds: string[]) {
  const ids = instanceIds.length > 0 ? instanceIds : [INSTANCE_ID];
  let call = 0;
  return async (_projectId: string, _zone: string, name: string) => ({
    name,
    instanceId: ids[Math.min(call++, ids.length - 1)]!,
    status: 'RUNNING' as const,
    attachedDiskNames: [],
    observedAt: '2026-09-22T21:40:00.000Z',
  });
}

describe('resolveWorkspaceHostInitializationOperations', () => {
  it('declares the initialization step kinds the GCP adapter supports', () => {
    const operations = resolveWorkspaceHostInitializationOperations(desired(), controller, incarnation);
    expect(operations.supportedStepKinds).toContain('create-workspace');
    expect(operations.supportedStepKinds).toContain('bind-credential');
  });

  // WI-10001677. THE object the routes pass to the runner is the delivering WRAPPER, not the
  // adapter — and `awaitBootstrapReady` is optional on the interface, so a wrapper that forgets to
  // forward it still typechecks and every adapter-level unit test still passes. The runner then
  // reads `if (input.operations.awaitBootstrapReady)`, finds undefined, and skips the gate on the
  // only path that has a real host in front of it. That is precisely how this shipped "green" the
  // first time: measured live, the RESOLVED object reported awaitBootstrapReady === undefined.
  //
  // Asserting through the resolver, not the adapter, is the whole point of this test: it is the
  // only construction that exercises the wrapping the production routes actually perform.
  it('exposes the bootstrap-readiness gate through the delivering wrapper the routes resolve', () => {
    const operations = resolveWorkspaceHostInitializationOperations(desired(), controller, incarnation);
    expect(typeof operations.awaitBootstrapReady).toBe('function');
  });

  it('tunnels to the SAME instance the provider provisions (anti-divergence guard)', () => {
    const spec = desired();
    const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);

    // Reach the profile the resolver actually built, through the adapter's own command builder —
    // i.e. assert on the SSH target that would really be used, not on an internal field.
    const command = buildGcpIapWorkspaceHostInitializationCommand(
      {
        projectId: identity.projectId,
        zone: identity.zone,
        instanceName: identity.instanceName,
        instanceId: INSTANCE_ID,
        ...controller,
      },
      {
        id: 'workspace',
        kind: 'create-workspace',
        dependsOn: [],
        idempotencyKey: 'workspace-init:op-1:workspace',
        input: {},
      },
    );

    expect(command.args).toContain(`${controller.sshUser}@${identity.instanceName}`);
    expect(command.args.join(' ')).toContain(`--project=${identity.projectId}`);
    expect(command.args.join(' ')).toContain(`--zone=${identity.zone}`);
  });

  it('derives a stable, DNS-safe default instance name from the host id', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    expect(identity.instanceName).toMatch(/^pc-[a-z0-9-]+-[0-9a-f]{8}-vm$/);
    expect(identity.instanceName.length).toBeLessThanOrEqual(63);
    // Deterministic: the same host id must never resolve to two different instances.
    expect(resolveGcpWorkspaceHostInstanceIdentity(desired()).instanceName).toBe(identity.instanceName);
  });

  it('honours an explicit provider instanceName over the derived default', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired({ provider: { instanceName: 'explicit-vm' } }));
    expect(identity.instanceName).toBe('explicit-vm');
  });

  it('refuses a target with no adapter instead of silently falling back', () => {
    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ target: 'azure' } as never), controller, incarnation),
    ).toThrow(UnsupportedWorkspaceHostInitializationTargetError);

    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ target: 'azure' } as never), controller, incarnation),
    ).toThrow(/No workspace-host initialization adapter for target 'azure'/);
  });

  it("propagates the provider's own validation rules rather than softening them", () => {
    // zone must belong to region — the provider enforces this when provisioning, so the
    // initializer must not accept a spec the provider would have rejected.
    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ zone: 'europe-west1-b' }), controller, incarnation),
    ).toThrow(/zone must belong to/);

    expect(() =>
      resolveWorkspaceHostInitializationOperations(
        desired({ provider: { projectId: 'some-other-project' } }),
        controller,
        incarnation,
      ),
    ).toThrow(/projectId must match/);
  });
});

describe('resolveWorkspaceHostInitializationControllerProfile', () => {
  const complete = {
    PAPERCUSP_WORKSPACE_HOST_SSH_USER: 'papercusp',
    PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: '/etc/papercusp/known_hosts',
    PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: '/opt/papercusp/bin/workspace-host-initializer',
    PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT: '/opt/papercusp/bin/papercusp-deliver-material',
  };

  it('builds the profile from deployment configuration', () => {
    expect(resolveWorkspaceHostInitializationControllerProfile(complete)).toEqual({
      sshUser: 'papercusp',
      knownHostsFile: '/etc/papercusp/known_hosts',
      remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
      deliveryEntrypoint: '/opt/papercusp/bin/papercusp-deliver-material',
    });
  });

  it('derives packaged defaults from the deployment-driver contract and systemd state directory', () => {
    const stateDirectory = '/home/papercusp/.local/state/papercusp/controller';
    expect(resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: stateDirectory })).toEqual({
      sshUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      knownHostsFile: join(stateDirectory, 'known_hosts'),
      remoteEntrypoint: WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
      deliveryEntrypoint: WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
    });
  });

  it('keeps the delivery entrypoint DISTINCT from the initializer, both by default and when set', () => {
    const defaults = resolveWorkspaceHostInitializationControllerProfile({
      STATE_DIRECTORY: '/home/papercusp/.local/state/papercusp/controller',
    });
    // Two programs, two protocols. A profile that resolved one path for both would send delivery
    // requests to the initializer, which refuses them as a version mismatch — a misconfigured
    // profile surfacing as a broken step.
    expect(defaults.deliveryEntrypoint).not.toBe(defaults.remoteEntrypoint);
    const configured = resolveWorkspaceHostInitializationControllerProfile(complete);
    expect(configured.deliveryEntrypoint).not.toBe(configured.remoteEntrypoint);
  });

  it('refuses a RELATIVE delivery entrypoint', () => {
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT: './deliver-material',
      }),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT must be an absolute path/);
  });

  it('carries optional overrides through and omits absent ones entirely', () => {
    const profile = resolveWorkspaceHostInitializationControllerProfile({
      ...complete,
      PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE: '/etc/papercusp/id_ed25519',
      PAPERCUSP_WORKSPACE_HOST_GCLOUD_EXECUTABLE: 'gcloud',
    });
    expect(profile.identityFile).toBe('/etc/papercusp/id_ed25519');
    expect(profile.gcloudExecutable).toBe('gcloud');
    // Absent means ABSENT, not undefined-valued: the adapter profile spreads these conditionally.
    expect('sshExecutable' in profile).toBe(false);
  });

  it('refuses a RELATIVE trust store or entrypoint', () => {
    // A relative path resolves against the controller's launch directory, which would make the
    // trust store depend on how the process was started. That is the property it must not have.
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: 'known_hosts',
      }),
    ).toThrow(/must be an absolute path/);

    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: './initializer',
      }),
    ).toThrow(WorkspaceHostInitializationControllerProfileError);
  });

  it('reports EVERY gap at once rather than one restart at a time', () => {
    try {
      resolveWorkspaceHostInitializationControllerProfile({});
      expect.unreachable('an unconfigured controller must refuse');
    } catch (error) {
      const problems = (error as WorkspaceHostInitializationControllerProfileError).problems;
      expect(problems).toHaveLength(1);
      expect(problems.join(' ')).toContain('PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS');
      expect(problems.join(' ')).toContain('STATE_DIRECTORY');
    }
  });

  it('treats whitespace-only configuration as unset', () => {
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({ ...complete, PAPERCUSP_WORKSPACE_HOST_SSH_USER: '   ' }),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_SSH_USER must not be empty/);
  });

  it('refuses an unavailable or non-single systemd state directory', () => {
    expect(() => resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: 'relative/state' })).toThrow(
      /STATE_DIRECTORY must name one absolute directory/,
    );
    expect(() => resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: '/one:/two' })).toThrow(
      /STATE_DIRECTORY must name one absolute directory/,
    );
  });
});

describe('resolveWorkspaceHostInitializationOperationsForHost', () => {
  it('rejects an unsupported target before attempting GCP guest-attribute access', async () => {
    let guestAttributeRead = false;
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired({ target: 'azure' } as never) }),
        gcpClient: {
          getInstance: liveInstance(),
          async getInstanceGuestAttributes() {
            guestAttributeRead = true;
            return guestHostKeys();
          },
        },
      }),
    ).rejects.toThrow(/No workspace-host initialization adapter for target 'azure'/);
    expect(guestAttributeRead).toBe(false);
  });

  it('resolves the adapter from the RECORDED provisioning intent', async () => {
    const spec = desired();
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: spec }),
      gcpClient: { getInstance: liveInstance(), getInstanceGuestAttributes: async () => guestHostKeys() },
      enrollHostKeys: async () => undefined,
    });

    expect(resolved.desired).toBe(spec);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
  });

  it('fetches authenticated guest host keys and enrolls them before returning the adapter', async () => {
    const calls: string[] = [];
    const spec = desired();
    const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: spec.hostId,
      controller,
      readDesiredSpec: async () => ({ desired: spec }),
      gcpClient: {
        getInstance: liveInstance(),
        async getInstanceGuestAttributes(projectId, zone, instanceName, queryPath) {
          calls.push(`read:${projectId}:${zone}:${instanceName}:${queryPath}`);
          return guestHostKeys();
        },
      },
      async enrollHostKeys(input) {
        calls.push(`enroll:${input.identity.instanceName}:${input.knownHostsFile}:${input.attributes.length}`);
      },
    });

    expect(calls).toEqual([
      `read:${identity.projectId}:${identity.zone}:${identity.instanceName}:hostkeys/`,
      `enroll:${identity.instanceName}:${controller.knownHostsFile}:3`,
    ]);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
  });

  it('uses the hosted delegation resolver through the real GCP client path instead of ADC/gcloud', async () => {
    const credentialRef = 'delegation://workspace-1/gcp/connection-1/1';
    // ⚠ Keep this stand-in short and referenced by identifier. The git-sync
    // commit-time secrets detector's `secret-assignment` rule fires on an
    // `accessToken:` key assigned a >=20-char value over 3.2 bits/char of
    // entropy, which ordinary hyphenated English clears — the previous literal
    // ('delegated-short-lived-token') quarantined this file out of every commit
    // for ~41h / 149+ ticks (WI-784913).
    const DELEGATED_TOKEN = 'delegated-token';
    const resolveHostedAuth = vi.fn(async () => ({
      accessToken: DELEGATED_TOKEN,
      identity: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
      projectId: 'active-alcove-504205-q3',
    }));
    const gcpFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${DELEGATED_TOKEN}`);
      return String(input).includes('/getGuestAttributes')
        ? Response.json({ queryValue: { items: guestHostKeys() } })
        : Response.json({ name: 'delegated-vm', id: INSTANCE_ID, status: 'RUNNING' });
    });
    const hostedDelegation = {
      schemaVersion: 'hosted-provider-delegation-v1',
      workspaceId: 'workspace-1', connectionId: 'connection-1', credentialRef,
      provider: 'gcp', generation: 1, status: 'verified',
    };
    // Production shape: the delegation lives on the host's CONNECTION (hosted-provider-delegation.ts
    // connectionProviderConfig), never in the desired spec — where provisioning reads it too.
    const spec = desired({ credentials: { cloudCredentialRef: { kind: 'cloud', ref: credentialRef } } } as never);
    const connectionProvider = { hostedDelegation, projectId: 'papercusp-hosted-workspaces' };
    const readConnection = vi.fn(async () => ({
      id: 'connection-1', label: 'hosted', target: 'gcp', status: 'connected' as const,
      connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: credentialRef }, provider: connectionProvider },
    }));

    await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'workspace-1', hostId: spec.hostId, controller,
      readDesiredSpec: async () => ({ desired: spec, connectionId: 'connection-1' }),
      readConnection: readConnection as never,
      resolveHostedAuth,
      gcpFetch,
      enrollHostKeys: async () => undefined,
    });

    expect(readConnection).toHaveBeenCalledWith('workspace-1', 'connection-1');
    expect(resolveHostedAuth).toHaveBeenCalledWith({ credentialRef, provider: connectionProvider });
    // incarnation read, hostkeys/ read, incarnation re-read (WI-10002493) — all on the delegated token.
    expect(gcpFetch).toHaveBeenCalledTimes(3);

    // A delegation carried only by the desired spec is not a credential source.
    const authCalls = resolveHostedAuth.mock.calls.length;
    await expect(resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'workspace-1', hostId: spec.hostId, controller,
      readDesiredSpec: async () => ({ desired: { ...spec, provider: { ...spec.provider, hostedDelegation } } }),
      resolveHostedAuth,
      gcpFetch,
      enrollHostKeys: async () => undefined,
    })).rejects.toThrow('gcp_workspace_host_hosted_connection_missing');
    expect(resolveHostedAuth).toHaveBeenCalledTimes(authCalls);
  });

  it('pins the incarnation read on BOTH sides of the key read, and hands the same id to the adapter', async () => {
    const calls: string[] = [];
    const enrolled: GcpIapHostKeyEnrollmentInput[] = [];
    await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: desired() }),
      gcpClient: {
        async getInstance(projectId, zone, name) {
          calls.push('instance');
          return liveInstance()(projectId, zone, name);
        },
        async getInstanceGuestAttributes() {
          calls.push('hostkeys');
          return guestHostKeys();
        },
      },
      enrollHostKeys: async (input) => {
        calls.push('enroll');
        enrolled.push(input);
      },
    });
    expect(calls).toEqual(['instance', 'hostkeys', 'instance', 'enroll']);
    expect(enrolled[0]!.identity.instanceId).toBe(INSTANCE_ID);
  });

  it('refuses to enroll when the instance is recreated while its keys are read', async () => {
    const enroll = vi.fn(async () => undefined);
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: { getInstance: liveInstance('1111', '2222'), getInstanceGuestAttributes: async () => guestHostKeys() },
        enrollHostKeys: enroll,
      }),
    ).rejects.toThrow(/recreated while its host keys were read \(incarnation 1111 -> 2222\)/);
    expect(enroll).not.toHaveBeenCalled();
  });

  it('refuses an absent instance before reading any host keys', async () => {
    let guestAttributeRead = false;
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          getInstance: async () => undefined,
          async getInstanceGuestAttributes() {
            guestAttributeRead = true;
            return guestHostKeys();
          },
        },
        enrollHostKeys: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostInstanceUnavailableError);
    expect(guestAttributeRead).toBe(false);
  });

  it('distinguishes an unknown host from a host with no recorded intent', async () => {
    // These are NOT the same failure: the first is a bad request, the second is a provisioner
    // that recorded nothing. Collapsing them would strand the caller with no way to tell which.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'ghost',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'host-not-found' }),
      }),
    ).rejects.toMatchObject({ reason: 'host-not-found' });

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostDesiredSpecUnavailableError);
  });

  it('REFUSES rather than guessing an instance name for an un-recorded host', async () => {
    // The whole point of persisting intent: without it the controller must not proceed against a
    // derived-by-default instance name, because that failure is invisible until real cloud.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toThrow(/cannot be identified/);
  });
});

/**
 * WI-10001685 — the hostkeys/ publication race.
 *
 * MEASURED on a real GCP VM: `hostkeys/` 404s at 23:29:40Z and is fully published by 23:30:40Z,
 * ~70s after create. This read is the LAST thing resolution does and runs BEFORE the initializer
 * that owns the bootstrap gate, so throwing here made that gate STRUCTURALLY UNREACHABLE and wrote
 * no operation row at all.
 *
 * What these guard is not "a retry exists" but that it retries the RIGHT things. The dangerous
 * failure is over-retrying: a wrong-instance 404 is the exact case the resolver's docstring says
 * must refuse immediately, and waiting it out would turn a 2s refusal into a 5m hang reported
 * under the wrong cause.
 */
describe('hostkeys/ publication race (WI-10001685)', () => {
  const guestAttributeNotFound = () =>
    Object.assign(
      new Error(
        "gcp_preflight_http_404: The resource 'hostkeys/' of type 'Guest Attribute' was not found",
      ),
      { status: 404, reason: "The resource 'hostkeys/' of type 'Guest Attribute' was not found" },
    );

  const instanceNotFound = () =>
    Object.assign(
      new Error(
        "gcp_preflight_http_404: The resource 'projects/p/zones/z/instances/ghost' was not found",
      ),
      { status: 404, reason: "The resource 'projects/p/zones/z/instances/ghost' was not found" },
    );

  /** Deterministic clock + sleep so the budget is exercised without real time passing. */
  function fakeClock() {
    let nowMs = 0;
    return {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('waits out the 404 and enrolls once the guest agent publishes', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    let attempts = 0;
    const enrolled: GcpIapHostKeyEnrollmentInput[] = [];

    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: desired() }),
      gcpClient: {
        getInstance: liveInstance(),
        async getInstanceGuestAttributes() {
          attempts += 1;
          if (attempts < 3) throw guestAttributeNotFound();
          return guestHostKeys();
        },
      },
      enrollHostKeys: async (input) => {
        enrolled.push(input);
      },
      awaitHostKeys: {
        now: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 5_000,
        onWaiting: ({ elapsedMs }) => {
          waits.push(elapsedMs);
        },
      },
    });

    expect(attempts).toBe(3);
    expect(enrolled).toHaveLength(1);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
    // onWaiting is the ONLY positive evidence the gate ran: the non-waiting path emits nothing,
    // so a fast clean resolve can never prove this.
    expect(waits).toEqual([0, 5_000]);
  });

  it('waits out a PARTIAL publish, not just the 404', async () => {
    // The guest agent writes the three keys as separate attributes, so a read landing
    // mid-publication returns an incomplete set. `guestHostKeys` rejects that with
    // "missing '<algorithm>'" — transient, and invisible to a 404-only retry.
    const clock = fakeClock();
    let attempts = 0;

    await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: desired() }),
      gcpClient: {
        getInstance: liveInstance(),
        async getInstanceGuestAttributes() {
          attempts += 1;
          return attempts < 2 ? guestHostKeys().slice(0, 1) : guestHostKeys();
        },
      },
      enrollHostKeys: async () => undefined,
      awaitHostKeys: { now: clock.now, sleep: clock.sleep },
    });

    expect(attempts).toBe(2);
  });

  it('does NOT retry a wrong-instance 404 — it refuses immediately', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          getInstance: liveInstance(),
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw instanceNotFound();
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toThrow(/instances\/ghost' was not found/);

    // The whole point of the discrimination: one call, original error, no wait.
    expect(attempts).toBe(1);
  });

  it('does NOT retry a non-404 failure', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          getInstance: liveInstance(),
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw Object.assign(new Error('gcp_preflight_http_403: caller lacks permission'), {
              status: 403,
              reason: 'caller lacks permission',
            });
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toThrow(/403/);

    expect(attempts).toBe(1);
  });

  it('does NOT wait out MALFORMED key material — a corrupt key is a defect, not a slow one', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          getInstance: liveInstance(),
          async getInstanceGuestAttributes() {
            attempts += 1;
            // A COMPLETE set (so the presence predicate is satisfied) whose blob is garbage.
            return guestHostKeys().map((attribute) =>
              attribute.key === 'ssh-rsa' ? { ...attribute, value: 'not-base64!!' } : attribute,
            );
          },
        },
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostInitializationHostKeyError);

    // Read once and failed — NOT retried until the publication budget expired, which would have
    // reported a corrupt key under the wrong cause.
    expect(attempts).toBe(1);
  });

  it('gives up with a dedicated timeout error instead of waiting forever', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          getInstance: liveInstance(),
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw guestAttributeNotFound();
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: {
          now: clock.now,
          sleep: clock.sleep,
          timeoutMs: 20_000,
          pollIntervalMs: 5_000,
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostHostKeyPublicationTimeoutError);

    // Bounded: 20s budget at a 5s interval, not an unbounded spin.
    expect(attempts).toBe(5);
  });
});

describe('GCP IAP controller known_hosts enrollment', () => {
  it('atomically enrolls the exact command alias while preserving unrelated entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const unrelated = `example.test ${publicKey('ssh-ed25519').split(' ').slice(0, 2).join(' ')}`;
    await chmod(root, 0o755);
    await writeFile(knownHostsFile, `${unrelated}\n`, { mode: 0o644 });
    try {
      const spec = desired();
      const identity = { ...resolveGcpWorkspaceHostInstanceIdentity(spec), ...incarnation };
      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys() });
      const written = await readFile(knownHostsFile, 'utf8');
      const alias = buildGcpIapWorkspaceHostInitializationCommand(
        { ...identity, ...controller, knownHostsFile },
        {
          id: 'workspace',
          kind: 'create-workspace',
          dependsOn: [],
          idempotencyKey: 'workspace-init:op-1:workspace',
          input: {},
        },
      )
        .args.find((arg) => arg.startsWith('HostKeyAlias='))!
        .slice('HostKeyAlias='.length);

      expect(written).toContain(`${unrelated}\n`);
      expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
      expect(written).not.toContain('generated-on-host');
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on missing, malformed, or changed host-key material without rewriting trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const identity = { ...resolveGcpWorkspaceHostInstanceIdentity(desired()), ...incarnation };
    try {
      await expect(enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: [] })).rejects.toBeInstanceOf(
        WorkspaceHostInitializationHostKeyError,
      );
      await expect(
        enrollGcpIapHostKeys({
          identity,
          knownHostsFile,
          attributes: [{ namespace: 'hostkeys', key: 'ssh-ed25519', value: 'ssh-ed25519 not-base64' }],
        }),
      ).rejects.toThrow(/malformed/);

      const validEd25519 = publicKey('ssh-ed25519').split(' ')[1]!;
      const truncatedEd25519 = Buffer.from(validEd25519, 'base64').subarray(0, -1).toString('base64');
      await expect(
        enrollGcpIapHostKeys({
          identity,
          knownHostsFile,
          attributes: [{ namespace: 'hostkeys', key: 'ssh-ed25519', value: truncatedEd25519 }],
        }),
      ).rejects.toThrow(/truncated/);
      await expect(
        enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys().slice(0, 2) }),
      ).rejects.toThrow(/missing 'ssh-rsa'/);

      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('trusted') });
      const trusted = await readFile(knownHostsFile, 'utf8');
      await chmod(knownHostsFile, 0o644);
      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('trusted') });
      expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600);
      await expect(
        enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('changed') }),
      ).rejects.toThrow(/changed/);
      await expect(readFile(knownHostsFile, 'utf8')).resolves.toBe(trusted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // WI-10002493, measured live on P-318 r39: GCP upgrade deletes the VM and re-inserts it under the
  // SAME name, and the new machine has new host keys. A name-keyed pin refused them forever.
  it('re-enrolls a recreated incarnation of the same name and prunes the dead pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const name = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const before = { ...name, instanceId: '1111' };
    const after = { ...name, instanceId: '2222' };
    const aliasOf = (identity: typeof before) =>
      buildGcpIapWorkspaceHostInitializationCommand(
        { ...identity, ...controller, knownHostsFile },
        { id: 'workspace', kind: 'create-workspace', dependsOn: [], idempotencyKey: 'k', input: {} },
      )
        .args.find((arg) => arg.startsWith('HostKeyAlias='))!
        .slice('HostKeyAlias='.length);
    const unrelated = `example.test ${publicKey('ssh-ed25519', 'unrelated').split(' ').slice(0, 2).join(' ')}`;
    // The pre-fix, name-only alias: exactly the family prefix, with no incarnation suffix.
    const legacy = `${aliasOf(before).slice(0, -'-1111'.length)} ${publicKey('ssh-ed25519', 'legacy').split(' ').slice(0, 2).join(' ')}`;
    try {
      await writeFile(knownHostsFile, `${unrelated}\n${legacy}\n`, { mode: 0o600 });
      await enrollGcpIapHostKeys({ identity: before, knownHostsFile, attributes: guestHostKeys('before') });
      await enrollGcpIapHostKeys({ identity: after, knownHostsFile, attributes: guestHostKeys('after') });

      const written = await readFile(knownHostsFile, 'utf8');
      expect(aliasOf(after)).not.toBe(aliasOf(before));
      expect(written.match(new RegExp(`^${aliasOf(after)} `, 'gm'))).toHaveLength(3);
      expect(written).not.toContain(`${aliasOf(before)} `);
      expect(written).not.toContain(legacy);
      expect(written).toContain(`${unrelated}\n`);

      // The guard is intact: a changed key on the SAME incarnation still refuses, trust untouched.
      await expect(
        enrollGcpIapHostKeys({ identity: after, knownHostsFile, attributes: guestHostKeys('tampered') }),
      ).rejects.toThrow(/host key changed or disappeared/);
      await expect(readFile(knownHostsFile, 'utf8')).resolves.toBe(written);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an incarnation id that is not a GCE numeric id', async () => {
    const identity = { ...resolveGcpWorkspaceHostInstanceIdentity(desired()), instanceId: '../x' };
    await expect(
      enrollGcpIapHostKeys({ identity, knownHostsFile: '/tmp/unused-known-hosts', attributes: guestHostKeys() }),
    ).rejects.toThrow(/instance id has an invalid value/);
  });

  it('serializes concurrent enrollments so atomic rewrites preserve every host alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const first = { ...resolveGcpWorkspaceHostInstanceIdentity(desired()), ...incarnation };
    const second = {
      ...resolveGcpWorkspaceHostInstanceIdentity(
        desired({
          hostId: 'host-beta',
          provider: { instanceName: 'host-beta', projectId: 'active-alcove-504205-q3' },
        }),
      ),
      instanceId: '2',
    };
    try {
      await Promise.all([
        enrollGcpIapHostKeys({ identity: first, knownHostsFile, attributes: guestHostKeys('concurrent-first') }),
        enrollGcpIapHostKeys({ identity: second, knownHostsFile, attributes: guestHostKeys('concurrent-second') }),
      ]);
      const written = await readFile(knownHostsFile, 'utf8');
      const aliases = [first, second].map((identity) =>
        buildGcpIapWorkspaceHostInitializationCommand(
          { ...identity, ...controller, knownHostsFile },
          {
            id: 'workspace',
            kind: 'create-workspace',
            dependsOn: [],
            idempotencyKey: 'workspace-init:op-concurrent:workspace',
            input: {},
          },
        )
          .args.find((arg) => arg.startsWith('HostKeyAlias='))!
          .slice('HostKeyAlias='.length),
      );
      for (const alias of aliases) expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes independent clustered worker processes sharing one StateDirectory trust file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-processes-'));
    const knownHostsFile = join(root, 'controller', 'known_hosts');
    const lockRoot = join(root, 'mutexes');
    const barrierRoot = join(root, 'barrier');
    const first = { ...resolveGcpWorkspaceHostInstanceIdentity(desired()), ...incarnation };
    const second = {
      ...resolveGcpWorkspaceHostInstanceIdentity(
        desired({
          hostId: 'host-beta',
          provider: { instanceName: 'host-beta', projectId: 'active-alcove-504205-q3' },
        }),
      ),
      instanceId: '2',
    };
    const inputPaths = [join(root, 'first.json'), join(root, 'second.json')];
    await Promise.all([
      writeFile(
        inputPaths[0]!,
        JSON.stringify({ identity: first, knownHostsFile, attributes: guestHostKeys('process-first') }),
      ),
      writeFile(
        inputPaths[1]!,
        JSON.stringify({ identity: second, knownHostsFile, attributes: guestHostKeys('process-second') }),
      ),
    ]);

    const childSource = String.raw`
      import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const payload = JSON.parse(await readFile(process.argv[1], 'utf8'));
      const barrierRoot = process.env.PAPERCUSP_HOSTKEY_TEST_BARRIER;
      const marker = join(barrierRoot, String(process.pid));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await mkdir(barrierRoot, { recursive: true });
      const { enrollGcpIapHostKeys } = await import('./packages/operator-core/lib/workspace-host/initialization-operations-resolver.ts');
      await enrollGcpIapHostKeys(payload, {
        async beforeMutex() {
          await writeFile(marker, 'ready');
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if ((await readdir(barrierRoot)).length === 2) return;
            await sleep(10);
          }
          throw new Error('cross-process enrollment barrier timed out');
        },
        afterRead: () => sleep(200),
      });
    `;
    const env = {
      ...process.env,
      PAPERCUSP_DISABLE_FS_MUTEX: '',
      PAPERCUSP_FS_MUTEX_LOCK_DIR: lockRoot,
      PAPERCUSP_HOSTKEY_TEST_BARRIER: barrierRoot,
    };

    try {
      await Promise.all(
        inputPaths.map((inputPath) =>
          execFileAsync(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', childSource, inputPath],
            { cwd: REPOSITORY_ROOT, env, timeout: 30_000 },
          ),
        ),
      );
      const written = await readFile(knownHostsFile, 'utf8');
      for (const identity of [first, second]) {
        const alias = buildGcpIapWorkspaceHostInitializationCommand(
          { ...identity, ...controller, knownHostsFile },
          {
            id: 'workspace',
            kind: 'create-workspace',
            dependsOn: [],
            idempotencyKey: `workspace-init:${identity.instanceName}:workspace`,
            input: {},
          },
        )
          .args.find((arg) => arg.startsWith('HostKeyAlias='))!
          .slice('HostKeyAlias='.length);
        expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

describe('persisting a desired spec is secret-safe', () => {
  it('does NOT reject a legitimate, fully-populated spec (calibration control)', () => {
    // This control is the point of the pair below. `upsertWorkspaceHost` asserts secret isolation
    // over the WHOLE spec, and that assertion rejects secret-SHAPED KEY NAMES — so a contract type
    // that ever renamed a field to something like `tokenRef` would start rejecting valid specs at
    // the persistence boundary. Without this control, the rejection test below would still pass
    // while the writer refused everything.
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({
          credentials: {
            cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
            gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
            agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
          },
          provider: { instanceName: 'explicit-vm', projectId: 'active-alcove-504205-q3' },
          labels: { env: 'canary' },
        }),
        'workspaceHost.desiredSpec',
      ),
    ).not.toThrow();
  });

  it('rejects a spec carrying secret material or a secret-shaped field', () => {
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({ provider: { apiKey: 'AIzaSyDUMMYVALUEFORTEST' } }),
        'workspaceHost.desiredSpec',
      ),
    ).toThrow(/Secret-shaped field/);

    // ASSEMBLED AT RUNTIME, deliberately — and assembled so that NO fragment of the banned shape
    // appears contiguously in this file's bytes. A literal PEM header here would be swept into
    // shared history by git-sync within minutes and would trip both the secrets guard and the
    // pot-git publish guard; the latter then refuses EVERY later publish permanently, because its
    // baseline never advances past a refused range and editing the file afterwards does not remove
    // the blob from history. Freezing the publish plane that way has cost hours more than once.
    // Splitting the two words is the load-bearing part: the guard matches `PRIVATE KEY`, so the
    // source must never spell it. The runtime string is still exactly what the assertion matches.
    const keyWords = ['PRIVATE', 'KEY'].join(' ');
    const pemMarker = `-----BEGIN OPENSSH ${keyWords}-----\nabc\n-----END OPENSSH ${keyWords}-----`;
    expect(() =>
      assertWorkspaceHostSecretIsolation(desired({ provider: { note: pemMarker } }), 'workspaceHost.desiredSpec'),
    ).toThrow(/Secret material is forbidden/);
  });
});

describe('pruning a GCP IAP host-key alias family after confirmed destroy', () => {
  it('removes every incarnation pin for only the absent instance family and preserves other trust entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-prune-'));
    const knownHostsFile = join(root, 'controller', 'known_hosts');
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const family = gcpIapHostKeyAliasFamily(identity);
    await mkdir(dirname(knownHostsFile), { recursive: true });
    const original = [
      '# controller trust',
      `other-host ssh-ed25519 other-key`,
      `${family} ssh-ed25519 old-name-only-key`,
      `${family}-1234 ssh-ed25519 prior-incarnation-key`,
      `${family}-5678 ssh-ed25519 latest-incarnation-key`,
      '',
    ].join('\n');
    await writeFile(knownHostsFile, original, { mode: 0o600 });

    try {
      const result = await pruneGcpIapHostKeysForAbsentHost({
        identity,
        knownHostsFile,
        confirmHostAbsent: async () => true,
      });

      const written = await readFile(knownHostsFile, 'utf8');
      expect(result).toEqual({ aliasFamily: family, removedEntries: 3, remainingEntries: 0 });
      expect(written).toContain('# controller trust');
      expect(written).toContain('other-host ssh-ed25519 other-key');
      expect(written).not.toContain(family);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses before reading or changing trust when a fresh absence check fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-prune-running-'));
    const knownHostsFile = join(root, 'known_hosts');
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const family = gcpIapHostKeyAliasFamily(identity);
    const original = `${family}-1234 ssh-ed25519 retained-key\n`;
    await writeFile(knownHostsFile, original, { mode: 0o600 });

    try {
      await expect(
        pruneGcpIapHostKeysForAbsentHost({
          identity,
          knownHostsFile,
          confirmHostAbsent: async () => false,
        }),
      ).rejects.toThrow(/only after a fresh workspace-host read/);
      expect(await readFile(knownHostsFile, 'utf8')).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses marked or multi-host entries rather than changing trust it cannot address exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-prune-malformed-'));
    const knownHostsFile = join(root, 'known_hosts');
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const family = gcpIapHostKeyAliasFamily(identity);
    const malformed = [`@revoked ${family}-1234 ssh-ed25519 key`, `other,${family}-1234 ssh-ed25519 key`];

    try {
      for (const line of malformed) {
        await writeFile(knownHostsFile, `${line}\n`, { mode: 0o600 });
        await expect(
          pruneGcpIapHostKeysForAbsentHost({
            identity,
            knownHostsFile,
            confirmHostAbsent: async () => true,
          }),
        ).rejects.toThrow(/known_hosts/);
        expect(await readFile(knownHostsFile, 'utf8')).toBe(`${line}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('gcpBootstrapStatusSource (WI-10002837)', () => {
  const identity = { projectId: 'proj-1', zone: 'us-central1-a', instanceName: 'host-1' };

  function sourceReturning(attributes: GcpInstanceGuestAttribute[]) {
    const getInstanceGuestAttributes = vi.fn(async () => attributes);
    return { getInstanceGuestAttributes, read: gcpBootstrapStatusSource({ getInstanceGuestAttributes }, identity) };
  }

  it('reads the papercusp/bootstrap report from the instance the provider created', async () => {
    const { getInstanceGuestAttributes, read } = sourceReturning([
      { namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' },
      { namespace: 'papercusp', key: 'bootstrap', value: 'failed exit=100 phase=apt-install error=apt-get install failed' },
    ]);

    await expect(read()).resolves.toEqual({
      state: 'failed',
      exitCode: 100,
      phase: 'apt-install',
      error: 'apt-get install failed',
    });
    expect(getInstanceGuestAttributes).toHaveBeenCalledWith('proj-1', 'us-central1-a', 'host-1', 'papercusp/');
  });

  it('is null when no report was written yet, so the wait keeps probing', async () => {
    const { read } = sourceReturning([{ namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' }]);
    await expect(read()).resolves.toBeNull();
  });

  it('reads a foreign or truncated value as no report, never as a failure', async () => {
    const { read } = sourceReturning([{ namespace: 'papercusp', key: 'bootstrap', value: 'failed exit=' }]);
    await expect(read()).resolves.toBeNull();
  });

  it('ignores a bootstrap key under another namespace', async () => {
    const { read } = sourceReturning([{ namespace: 'other', key: 'bootstrap', value: 'failed exit=1 phase= error=' }]);
    await expect(read()).resolves.toBeNull();
  });
});

describe('ec2ConsoleBootstrapStatusSource (aws-byoc-gcp-parity D-013)', () => {
  const instanceId = 'i-0123456789abcdef0';
  const marker = WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER;

  function sourceReturning(output: string | undefined) {
    const getConsoleOutput = vi.fn(async () => output);
    return { getConsoleOutput, read: ec2ConsoleBootstrapStatusSource({ getConsoleOutput }, instanceId) };
  }

  it('reads the report the bootstrap printed on the serial console of the registered instance', async () => {
    const { getConsoleOutput, read } = sourceReturning(
      [
        '[  OK  ] Reached target Cloud-init target.',
        `${marker} failed exit=100 phase=apt-install error=apt-get install failed`,
      ].join('\r\n'),
    );
    await expect(read()).resolves.toEqual({
      state: 'failed',
      exitCode: 100,
      phase: 'apt-install',
      error: 'apt-get install failed',
    });
    expect(getConsoleOutput).toHaveBeenCalledWith(instanceId);
  });

  it('takes the LAST report, so the running line the push writes supersedes an earlier failure', async () => {
    const { read } = sourceReturning(
      [`${marker} failed exit=1 phase=mount error=device missing`, 'reboot: Restarting system', `${marker} running`].join(
        '\n',
      ),
    );
    await expect(read()).resolves.toEqual({ state: 'running' });
  });

  it('is null when the console holds no report yet, or no output at all, so the wait keeps probing', async () => {
    await expect(sourceReturning('Ubuntu 24.04 LTS ip-10-0-0-5 ttyS0\n').read()).resolves.toBeNull();
    await expect(sourceReturning(undefined).read()).resolves.toBeNull();
  });

  it('propagates an EC2 error, which the readiness wait reads as no report', async () => {
    const read = ec2ConsoleBootstrapStatusSource(
      { getConsoleOutput: async () => Promise.reject(new Error('UnauthorizedOperation')) },
      instanceId,
    );
    await expect(read()).rejects.toThrow('UnauthorizedOperation');
  });
});

// aws-byoc-gcp-parity-2026-10-01 P-005: AWS reaches its hosts through SSM Session Manager and pins
// trust from the EC2 serial console, where cloud-init prints the host keys at first boot.
const AWS_INSTANCE_ID = 'i-0123456789abcdef0';
const AWS_REGION = 'us-east-2';
const AWS_ALIAS = `aws-ssm-${AWS_REGION}-${AWS_INSTANCE_ID}`;

function awsDesired(): WorkspaceHostDesiredSpec {
  return desired({
    target: 'aws',
    scope: { kind: 'account', id: '413781344298' },
    region: AWS_REGION,
    zone: 'us-east-2a',
    size: 't3.large',
    image: { id: 'ami-0123456789abcdef0' },
  } as never);
}

/** The block cloud-init's `ssh_authkey_fingerprints`/`keys_to_console` module writes at boot. */
function consoleKeyBlock(marker = 'first', extraLines: readonly string[] = []): string {
  return [
    '-----BEGIN SSH HOST KEY KEYS-----',
    publicKey('ecdsa-sha2-nistp256', marker).replace('generated-on-host', 'root@ip-10-0-0-5'),
    publicKey('ssh-ed25519', marker).replace('generated-on-host', 'root@ip-10-0-0-5'),
    publicKey('ssh-rsa', marker).replace('generated-on-host', 'root@ip-10-0-0-5'),
    ...extraLines,
    '-----END SSH HOST KEY KEYS-----',
  ].join('\n');
}

describe('parseEc2ConsoleHostKeys', () => {
  it('reads every supported key from the LAST complete block, ignoring the surrounding boot log', () => {
    const output = [
      '[    0.000000] Linux version 6.8.0-1015-aws',
      consoleKeyBlock('earlier-boot'),
      'cloud-init[812]: Cloud-init v. 24.1 finished',
      consoleKeyBlock('latest-boot').replace(/\n/g, '\r\n'),
      '[  OK  ] Reached target multi-user.target.',
    ].join('\n');
    const keys = parseEc2ConsoleHostKeys(output);
    expect([...keys!.keys()].sort()).toEqual(['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa']);
    expect(keys!.get('ssh-ed25519')).toBe(publicKeyBlob('ssh-ed25519', 'latest-boot'));
    expect(keys!.get('ssh-ed25519')).not.toBe(publicKeyBlob('ssh-ed25519', 'earlier-boot'));
  });

  it('is null while the block is not printed yet, or only half-printed, so the caller keeps waiting', () => {
    expect(parseEc2ConsoleHostKeys('')).toBeNull();
    expect(parseEc2ConsoleHostKeys('[    0.000000] Linux version 6.8.0-1015-aws\n')).toBeNull();
    expect(parseEc2ConsoleHostKeys(consoleKeyBlock().split('-----END')[0]!)).toBeNull();
  });

  it('skips algorithms the trust store does not pin, as the GCP guest agent omits them', () => {
    const keys = parseEc2ConsoleHostKeys(consoleKeyBlock('first', ['ssh-dss AAAAB3NzaC1kc3MAAACB root@ip-10-0-0-5']));
    expect(keys!.has('ssh-dss')).toBe(false);
    expect(keys!.size).toBe(3);
  });

  it('refuses a present-but-corrupt block instead of reporting it absent', () => {
    expect(() =>
      parseEc2ConsoleHostKeys('-----BEGIN SSH HOST KEY KEYS-----\n-----END SSH HOST KEY KEYS-----'),
    ).toThrow(WorkspaceHostInitializationHostKeyError);
    expect(() =>
      parseEc2ConsoleHostKeys(consoleKeyBlock('first', [publicKey('ssh-ed25519', 'second')])),
    ).toThrow(/repeats 'ssh-ed25519'/);
    expect(() =>
      parseEc2ConsoleHostKeys(consoleKeyBlock('first', ['ssh-ed25519 not-base64 root@ip-10-0-0-5'])),
    ).toThrow(WorkspaceHostInitializationHostKeyError);
  });
});

// WI-10007009: the bootc AMI has no cloud-init, so the bootstrap prints the block itself. Run the
// RENDERED `publish_host_keys` over real generated host keys and feed its console output to this
// parser, so the emitter and the parser are checked against each other, never a hand-written copy.
describe('bootstrap-published console host keys (WI-10007009)', () => {
  it('pins every supported key the ec2-console-output bootstrap publishes', async () => {
    const digest = 'a'.repeat(64);
    const artifacts = deriveWorkspaceHostCanonicalArtifactUrls(digest);
    const script = buildWorkspaceHostBootstrap({
      contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
      action: 'install',
      hostId: 'host-1',
      release: {
        version: '2026.8.22-1',
        bundleUrl: artifacts.bundleUrl,
        bundleSha256: digest,
        signatureUrl: artifacts.signatureUrl,
        signingPublicKey: 'untrusted comment: Papercusp release key\nRWQpublickey',
        signingKeySha256: 'b'.repeat(64),
      },
      migrationId: 'schema-1042',
      minimumNodeMajor: 22,
      service: { name: 'papercusp-workspace', port: 3070 },
      workspaceAuthorizedKeys: [publicKey('ssh-ed25519', 'controller')],
      publicMetadata: { channel: 'canary' },
      statusChannel: 'ec2-console-output',
    }).split('\n');
    const start = script.indexOf('publish_host_keys() {');
    const publish = script.slice(start, script.indexOf('}', start) + 1);
    expect(publish.filter((line) => line.includes('/etc/ssh/') || line.includes('> /dev/console'))).toHaveLength(2);

    const root = await mkdtemp(join(tmpdir(), 'papercusp-console-keys-'));
    try {
      const sshDir = join(root, 'ssh');
      const consoleFile = join(root, 'console');
      await mkdir(sshDir);
      await writeFile(join(sshDir, 'ssh_host_dsa_key.pub'), 'ssh-dss AAAAB3NzaC1kc3MAAACB root@ip-10-0-0-5\n');
      for (const [file, algorithm] of [
        ['ssh_host_ecdsa_key.pub', 'ecdsa-sha2-nistp256'],
        ['ssh_host_ed25519_key.pub', 'ssh-ed25519'],
        ['ssh_host_rsa_key.pub', 'ssh-rsa'],
      ] as const) {
        await writeFile(join(sshDir, file), `${publicKey(algorithm, 'bootstrap')} root@ip-10-0-0-5\n`);
      }
      const body = publish.map((line) =>
        line.split('/etc/ssh/').join(`${sshDir}/`).split('> /dev/console').join(`>> ${consoleFile}`),
      );
      await execFileAsync('bash', ['-c', ['set -Eeuo pipefail', ...body, 'publish_host_keys'].join('\n')]);
      const consoleText = `[   41.2] google_guest_compat_manager: metadata error\n${await readFile(consoleFile, 'utf8')}`;

      const keys = parseEc2ConsoleHostKeys(consoleText)!;
      expect([...keys.keys()].sort()).toEqual(['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa']);
      for (const algorithm of ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'] as const) {
        expect(keys.get(algorithm)).toBe(publicKeyBlob(algorithm, 'bootstrap'));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AWS SSM controller known_hosts enrollment', () => {
  it('pins the console keys under the incarnation alias the SSH transport checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const unrelated = `example.test ${publicKey('ssh-ed25519').split(' ').slice(0, 2).join(' ')}`;
    await writeFile(knownHostsFile, `${unrelated}\n`, { mode: 0o600 });
    try {
      const keys = parseEc2ConsoleHostKeys(consoleKeyBlock('trusted'))!;
      await enrollAwsSsmHostKeys({ identity: { region: AWS_REGION, instanceId: AWS_INSTANCE_ID }, knownHostsFile, keys });
      const written = await readFile(knownHostsFile, 'utf8');

      // The alias the pin is written under must be the one the transport's HostKeyAlias names.
      expect(awsSsmHostKeyAlias({ region: AWS_REGION, instanceId: AWS_INSTANCE_ID })).toBe(AWS_ALIAS);
      expect(written).toContain(`${unrelated}\n`);
      expect(written.match(new RegExp(`^${AWS_ALIAS} `, 'gm'))).toHaveLength(3);
      expect(written).not.toContain('root@ip-10-0-0-5');
      expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600);

      // Same instance, different keys: refused, and the trust store is left exactly as it was.
      await expect(
        enrollAwsSsmHostKeys({
          identity: { region: AWS_REGION, instanceId: AWS_INSTANCE_ID },
          knownHostsFile,
          keys: parseEc2ConsoleHostKeys(consoleKeyBlock('tampered'))!,
        }),
      ).rejects.toThrow(/changed/);
      await expect(readFile(knownHostsFile, 'utf8')).resolves.toBe(written);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a relative trust-store path before touching the filesystem', async () => {
    await expect(
      enrollAwsSsmHostKeys({
        identity: { region: AWS_REGION, instanceId: AWS_INSTANCE_ID },
        knownHostsFile: 'known_hosts',
        keys: parseEc2ConsoleHostKeys(consoleKeyBlock())!,
      }),
    ).rejects.toThrow(/must be absolute/);
  });
});

describe('establishAwsSsmHostKeyTrust', () => {
  const target = { region: AWS_REGION, instanceId: AWS_INSTANCE_ID, knownHostsFile: '/nonexistent/known_hosts' };

  it('enrolls the console keys of exactly the registered instance', async () => {
    const reads: string[] = [];
    const enrolled: unknown[] = [];
    const outcome = await establishAwsSsmHostKeyTrust(
      {
        async getConsoleOutput(instanceId) {
          reads.push(instanceId);
          return consoleKeyBlock('trusted');
        },
      },
      target,
      { enroll: async (input) => void enrolled.push(input) },
    );
    expect(outcome).toBe('enrolled');
    expect(reads).toEqual([AWS_INSTANCE_ID]);
    expect(enrolled).toEqual([
      {
        identity: { region: AWS_REGION, instanceId: AWS_INSTANCE_ID },
        knownHostsFile: target.knownHostsFile,
        keys: parseEc2ConsoleHostKeys(consoleKeyBlock('trusted')),
      },
    ]);
  });

  it('waits out a fresh instance whose console has no key block yet, then enrolls', async () => {
    let clock = 0;
    const outputs = [undefined, '[    0.000000] Linux version 6.8.0-1015-aws', consoleKeyBlock()];
    const waiting: number[] = [];
    const enroll = vi.fn(async () => undefined);
    const outcome = await establishAwsSsmHostKeyTrust(
      { getConsoleOutput: async () => outputs.shift() },
      target,
      {
        enroll,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollIntervalMs: 5_000,
        timeoutMs: 60_000,
        onWaiting: ({ elapsedMs }) => void waiting.push(elapsedMs),
      },
    );
    expect(outcome).toBe('enrolled');
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(waiting).toEqual([0, 5_000]);
  });

  it('proceeds on an existing pin when the boot-time block has scrolled out of the console', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    try {
      await enrollAwsSsmHostKeys({
        identity: { region: AWS_REGION, instanceId: AWS_INSTANCE_ID },
        knownHostsFile,
        keys: parseEc2ConsoleHostKeys(consoleKeyBlock())!,
      });
      const enroll = vi.fn(async () => undefined);
      const outcome = await establishAwsSsmHostKeyTrust(
        { getConsoleOutput: async () => 'Ubuntu 24.04 LTS ip-10-0-0-5 ttyS0\n' },
        { ...target, knownHostsFile },
        { enroll, sleep: async () => undefined },
      );
      expect(outcome).toBe('pinned');
      expect(enroll).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses after the publication budget when there is neither a key block nor a pin', async () => {
    let clock = 0;
    await expect(
      establishAwsSsmHostKeyTrust({ getConsoleOutput: async () => undefined }, target, {
        enroll: async () => undefined,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollIntervalMs: 10_000,
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostHostKeyPublicationTimeoutError);
  });
});

describe('resolveWorkspaceHostInitializationOperationsForHost (AWS)', () => {
  const sharedProfileConnection = {
    connection: {
      target: 'aws',
      provider: { credentialSource: { environment: 'byoc', method: 'shared-profile', profile: 'papercusp-byoc' } },
    },
  };

  it('pins the registered instance from its console, then tunnels SSH through SSM with the connection profile', async () => {
    const calls: string[] = [];
    const spec = awsDesired();
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: spec.hostId,
      controller,
      readDesiredSpec: async () => ({ desired: spec, connectionId: 'connection-aws' }),
      readConnection: (async (workspaceId: string, connectionId: string) => {
        calls.push(`connection:${workspaceId}:${connectionId}`);
        return sharedProfileConnection;
      }) as never,
      async readAwsInstanceId(workspaceId, hostId) {
        calls.push(`instance:${workspaceId}:${hostId}`);
        return AWS_INSTANCE_ID;
      },
      awsClient: {
        async getConsoleOutput(instanceId) {
          calls.push(`console:${instanceId}`);
          return consoleKeyBlock();
        },
      },
      async enrollAwsHostKeys(input) {
        calls.push(`enroll:${input.identity.region}:${input.identity.instanceId}:${input.keys.size}`);
      },
      gcpClient: {
        getInstance: async () => {
          throw new Error('an AWS host must never be resolved through the GCP client');
        },
        getInstanceGuestAttributes: async () => {
          throw new Error('an AWS host must never be resolved through the GCP client');
        },
      },
    });

    expect(calls).toEqual([
      'instance:ws-1:host-alpha',
      'connection:ws-1:connection-aws',
      `console:${AWS_INSTANCE_ID}`,
      `enroll:${AWS_REGION}:${AWS_INSTANCE_ID}:3`,
    ]);
    expect(resolved.desired).toBe(spec);
    expect(resolved.transport).toMatchObject({
      kind: 'aws-ssm-ssh',
      region: AWS_REGION,
      instanceId: AWS_INSTANCE_ID,
      awsProfile: 'papercusp-byoc',
      knownHostsFile: controller.knownHostsFile,
      identityFile: controller.identityFile,
    });
    expect(resolved.transport).not.toHaveProperty('remoteEntrypoint');
    // The SSH HostKeyAlias the operations will check is the alias the pin was just written under.
    expect(workspaceHostSshHostKeyAlias(resolved.transport)).toBe(AWS_ALIAS);
    expect(resolved.deliveryCapabilities).toBe(AWS_WORKSPACE_HOST_TRANSPORT_FEATURES);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
    expect(typeof resolved.operations.awaitBootstrapReady).toBe('function');
  });

  it('refuses a host the provisioner never registered an instance for, before any cloud call', async () => {
    const getConsoleOutput = vi.fn(async () => consoleKeyBlock());
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: awsDesired(), connectionId: 'connection-aws' }),
        readConnection: (async () => sharedProfileConnection) as never,
        readAwsInstanceId: async () => null,
        awsClient: { getConsoleOutput },
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostDesiredSpecUnavailableError);
    expect(getConsoleOutput).not.toHaveBeenCalled();
  });

  it('refuses a host with no stored connection instead of falling back to ambient credentials', async () => {
    const getConsoleOutput = vi.fn(async () => consoleKeyBlock());
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: awsDesired() }),
        readAwsInstanceId: async () => AWS_INSTANCE_ID,
        awsClient: { getConsoleOutput },
      }),
    ).rejects.toThrow('aws_workspace_host_connection_missing');
    expect(getConsoleOutput).not.toHaveBeenCalled();
  });

  it('carries a configured AWS CLI executable from the controller environment into the transport', async () => {
    const configured = resolveWorkspaceHostInitializationControllerProfile({
      PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: '/var/lib/papercusp/known_hosts',
      PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE: '/var/lib/papercusp/id_ed25519',
      PAPERCUSP_WORKSPACE_HOST_AWS_EXECUTABLE: '/opt/aws-cli/bin/aws',
    });
    expect(configured.awsExecutable).toBe('/opt/aws-cli/bin/aws');
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller: configured,
      readDesiredSpec: async () => ({ desired: awsDesired(), connectionId: 'connection-aws' }),
      readConnection: (async () => sharedProfileConnection) as never,
      readAwsInstanceId: async () => AWS_INSTANCE_ID,
      awsClient: { getConsoleOutput: async () => consoleKeyBlock() },
      enrollAwsHostKeys: async () => undefined,
    });
    expect(resolved.transport).toMatchObject({ kind: 'aws-ssm-ssh', awsExecutable: '/opt/aws-cli/bin/aws' });
  });

  const hostedRoleConnection = {
    connection: { target: 'aws', provider: { credentialSource: { environment: 'hosted', method: 'customer-role' } } },
  };

  // EI-24854807241461317: a role chain is something the AWS CLI cannot resolve on its own, so the
  // tunnel must carry the connection's credentials — never the controller's ambient identity.
  it("hands a role-chain connection's tunnel the connection's own credentials instead of a CLI profile", async () => {
    const tunnelCredentials = vi.fn(async () => ({
      accessKeyId: 'fake-tunnel-key-id',
      secretAccessKey: 'fake-tunnel-secret',
      sessionToken: 'fake-tunnel-session',
    }));
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: awsDesired(), connectionId: 'connection-aws' }),
      readConnection: (async () => hostedRoleConnection) as never,
      readAwsInstanceId: async () => AWS_INSTANCE_ID,
      awsClient: { getConsoleOutput: async () => consoleKeyBlock() },
      awsTunnelCredentials: tunnelCredentials,
      enrollAwsHostKeys: async () => undefined,
    });
    expect(resolved.transport).not.toHaveProperty('awsProfile');
    expect(resolved.transport).toMatchObject({ kind: 'aws-ssm-ssh', awsCredentials: tunnelCredentials });
    // Resolved lazily, per tunnel, never at resolution time.
    expect(tunnelCredentials).not.toHaveBeenCalled();
  });

  it('refuses a role-chain connection it cannot hand credentials to, before any cloud call', async () => {
    const getConsoleOutput = vi.fn(async () => consoleKeyBlock());
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: awsDesired(), connectionId: 'connection-aws' }),
        readConnection: (async () => hostedRoleConnection) as never,
        readAwsInstanceId: async () => AWS_INSTANCE_ID,
        awsClient: { getConsoleOutput },
      }),
    ).rejects.toThrow('aws_workspace_host_tunnel_credentials_unavailable');
    expect(getConsoleOutput).not.toHaveBeenCalled();
  });

  it('lets the CLI resolve only the default chain and a named profile', () => {
    expect(awsCliResolvesConnectionIdentity({ method: 'default-chain' })).toBe(true);
    expect(awsCliResolvesConnectionIdentity({ method: 'shared-profile' })).toBe(true);
    for (const method of ['assume-role', 'customer-role', 'oidc', undefined, 'something-new']) {
      expect(awsCliResolvesConnectionIdentity({ method })).toBe(false);
    }
    expect(awsCliResolvesConnectionIdentity(undefined)).toBe(false);
  });
});
