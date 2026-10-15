import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WorkspaceHostCredentialMaterial,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION,
  GcpImageFamilyExactPathReadinessError,
  buildGcpImageFamilyExactPathReadinessConfig,
  composeGcpImageFamilyReleaseAdapter,
  CredentialScopedGcpImageFamilyCommandRunner,
  executeConfiguredGcpImageFamilyRelease,
  isSupportedGcpImageFamilyCredentialRef,
  parseGcpImageFamilyExactPathReadinessConfig,
  probeGcpImageFamilyCredential,
  probeGcpImageFamilyExecutables,
  safeGcpImageFamilyCommandEnvironment,
  verifyGcpImageFamilyExactPathReadiness,
  type GcpImageFamilyExactPathReadinessDependencies,
} from './gcp-image-family-production';
import {
  NodeGcpImageFamilyCommandRunner,
  type GcpImageFamilyCommand,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyCommandRunner,
} from './gcp-image-family-adapter';
import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
  workspaceHostAgentAdmissionProbeSpecs,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
} from './agent-credential-admission';

const connection = (overrides: Partial<WorkspaceHostProviderConnection> = {}): WorkspaceHostProviderConnection => ({
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
  scope: { kind: 'project', id: 'active-alcove-504205-q3' },
  provider: { projectId: 'active-alcove-504205-q3' },
  ...overrides,
});

describe('GCP image-family production composition', () => {
  it('strips process-global Google key/token channels from command environments', () => {
    const env = safeGcpImageFamilyCommandEnvironment({
      PATH: '/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'token',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'token',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined();
  });

  it('does not allow a per-call override to reintroduce a forbidden key path', async () => {
    const calls: Array<{ command: string; env?: Record<string, string | undefined> }> = [];
    const inner = {
      run: vi.fn(
        async (command: string, _args: readonly string[], options?: { env?: Record<string, string | undefined> }) => {
          calls.push({ command, env: options?.env });
          return { exitCode: 0, stdout: '', stderr: '' } satisfies GcpImageFamilyCommandResult;
        },
      ),
    };
    const runner = new CredentialScopedGcpImageFamilyCommandRunner(inner);
    await runner.run('packer', ['--version'], {
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/attempted-key.json', BUILD_MARKER: '1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({ BUILD_MARKER: '1' });
    expect(calls[0]?.env?.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('binds the persisted project and safe credential reference to the concrete adapter', () => {
    const composition = composeGcpImageFamilyReleaseAdapter(connection(), {
      acquireAuth: async () => ({ accessToken: 'test-token', projectId: 'active-alcove-504205-q3' }),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    });
    expect(composition.projectId).toBe('active-alcove-504205-q3');
    expect(composition.credentialRef).toBe('gcloud://active-user');
    expect(composition.adapter).toEqual(
      expect.objectContaining({
        buildCandidate: expect.any(Function),
        scanImage: expect.any(Function),
        inspectImage: expect.any(Function),
        launchCleanRoomCanary: expect.any(Function),
        publishFamilyVersion: expect.any(Function),
        resolveFamily: expect.any(Function),
        deprecateImage: expect.any(Function),
      }),
    );
  });

  it('rejects non-GCP and unsafe credential connections before constructing a provider', () => {
    expect(() => composeGcpImageFamilyReleaseAdapter(connection({ target: 'aws' }))).toThrow(
      /requires a 'gcp' connection/,
    );
    expect(() =>
      composeGcpImageFamilyReleaseAdapter(
        connection({ cloudCredentialRef: { kind: 'cloud', ref: 'env:GOOGLE_APPLICATION_CREDENTIALS' } }),
      ),
    ).toThrow(/must use adc:\/\//);
  });

  it('pins isSupportedGcpImageFamilyCredentialRef to what this seam actually accepts', () => {
    // ONE rule, two callers. Producers that build a connection (the image-release request CLI)
    // reject an unusable reference at their OWN edge using this predicate; the seam below is what
    // ultimately enforces it. A divergence between them is invisible at runtime and reads as a bug
    // in the wrong file: the CLI would either refuse a chain this seam would have taken, or wave
    // through one it will not. This table is the guard that keeps the two in lockstep.
    const refs = [
      'gcloud://active-user',
      '  gcloud://active-user  ',
      'adc://default',
      'adc://impersonate/release@active-alcove-504205-q3.iam.gserviceaccount.com',
      'env:GOOGLE_APPLICATION_CREDENTIALS',
      'hosted://papercusp/gcp',
      'adc://with space',
      'adc://',
      '',
    ];
    for (const ref of refs) {
      const predicateAccepts = isSupportedGcpImageFamilyCredentialRef(ref);
      let thrown: unknown;
      try {
        composeGcpImageFamilyReleaseAdapter(connection({ cloudCredentialRef: { kind: 'cloud', ref } }), {
          acquireAuth: async () => ({ accessToken: 'test-token', projectId: 'active-alcove-504205-q3' }),
          commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        });
      } catch (caught) {
        thrown = caught;
      }
      if (predicateAccepts) {
        expect(thrown, `predicate accepts ${JSON.stringify(ref)} but the seam refused it`).toBeUndefined();
      } else {
        // Assert the REASON, not merely that something threw — otherwise an unrelated failure
        // (a bad project, say) would make a real divergence look like agreement.
        expect(String(thrown), `predicate rejects ${JSON.stringify(ref)} but the seam took it`).toMatch(
          /[Cc]redentialRef/,
        );
      }
    }
  });

  it('probes short-lived auth without returning the bearer token and catches project mismatch', async () => {
    await expect(
      probeGcpImageFamilyCredential(connection(), {
        acquireAuth: async () => ({
          accessToken: 'never-returned',
          identity: 'owner@example.test',
          projectId: 'active-alcove-504205-q3',
        }),
      }),
    ).resolves.toEqual({
      ok: true,
      projectId: 'active-alcove-504205-q3',
      credentialRef: 'gcloud://active-user',
      identity: 'owner@example.test',
      resolvedProjectId: 'active-alcove-504205-q3',
    });
    await expect(
      probeGcpImageFamilyCredential(connection(), {
        acquireAuth: async () => ({ accessToken: 'token', projectId: 'other-project' }),
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/different GCP project/) });
  });

  it('checks configured executables without spawning a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcp-image-release-executables-'));
    try {
      const executable = join(dir, 'tool');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(executable, 0o755);
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: executable,
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: executable,
        }),
      ).resolves.toMatchObject({
        ok: true,
        missing: [],
        executables: {
          packer: executable,
          scanner: executable,
          cleanRoom: executable,
          bootstrapAcceptance: executable,
        },
      });
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: join(dir, 'missing'),
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: executable,
        }),
      ).resolves.toMatchObject({ ok: false, missing: ['packer'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The PRE-build acceptance binary produces the clean-room report the release gate ratifies.
   * It was registered in GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES but never probed, so the
   * read-only preflight reported `ok` while the release could not produce its gate evidence —
   * the exact class of failure this preflight exists to catch before any mutation.
   */
  it('fails the preflight when the pre-build bootstrap-acceptance binary is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcp-image-release-acceptance-'));
    try {
      const executable = join(dir, 'tool');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(executable, 0o755);
      await expect(
        probeGcpImageFamilyExecutables({
          packerExecutable: executable,
          scanExecutable: executable,
          cleanRoomExecutable: executable,
          bootstrapAcceptanceExecutable: join(dir, 'missing'),
        }),
      ).resolves.toMatchObject({
        ok: false,
        missing: ['bootstrapAcceptance'],
        executables: { bootstrapAcceptance: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks request/connection project identity before invoking the release executor', async () => {
    await expect(
      executeConfiguredGcpImageFamilyRelease({ projectId: 'other-project' } as never, connection(), {
        acquireAuth: async () => ({ accessToken: 'token', projectId: 'active-alcove-504205-q3' }),
        commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      }),
    ).rejects.toThrow(/does not match/);
  });
});

const READINESS_NOW = new Date('2026-09-07T12:00:00.000Z');
const SOURCE_REVISION = '1'.repeat(40);
const GITLINK_REVISION = '2'.repeat(40);
const GIT_GENERATION = 7;
const AGENT_GENERATION = 9;
const GIT_REF = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
  forge: 'github',
  owner: 'Papercusp',
  repository: 'papercusp',
});
const AGENT_REF = buildWorkspaceHostCredentialReference('agent-encrypted-reference', {
  hostId: 'release',
  agentSet: 'claude-codex-omp',
});
const GIT_MATERIAL = Buffer.from('https://git-user:private-token-value@github.com/Papercusp/papercusp.git\n');

function readinessRaw() {
  return {
    contractVersion: GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION,
    requestedAt: '2026-09-07T11:00:00.000Z',
    expected: { username: 'release-user', cwd: '/repo' },
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: SOURCE_REVISION,
      gitlinks: [{ path: 'libs/papercusp', revision: GITLINK_REVISION }],
    },
    credentials: {
      git: {
        credentialRef: { kind: 'git', ref: GIT_REF },
        delivery: {
          kind: 'short-lived-delegation',
          generation: GIT_GENERATION,
          audience: 'release',
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            'git-short-lived-delegation',
            { forge: 'github', owner: 'Papercusp', repository: 'papercusp' },
            GIT_GENERATION,
          ),
          expiresAt: '2027-09-07T12:00:00.000Z',
        },
        revokedThrough: 0,
      },
      agent: {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: {
          kind: 'encrypted-reference',
          generation: AGENT_GENERATION,
          audience: 'release',
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            'agent-encrypted-reference',
            { hostId: 'release', agentSet: 'claude-codex-omp' },
            AGENT_GENERATION,
          ),
        },
        revokedThrough: 0,
      },
    },
    storage: {
      minimumFreeBytes: 100,
      minimumFreeInodes: 10,
      retainedPaths: ['.papercusp/state'],
    },
  };
}

function agentAdmission(): WorkspaceHostAgentCredentialAdmissionEvidence {
  const observedAt = READINESS_NOW.toISOString();
  // Each agent's receipt takes the kind and disclosure of the probe admission actually RUNS for it
  // (WI-10005806): a fixture that labels every agent authenticated-account is a receipt no real
  // probe can produce, and the shipped validator refuses it.
  const agents = Object.fromEntries(
    (['claude', 'codex', 'omp'] as const).map((agent) => {
      const spec = workspaceHostAgentAdmissionProbeSpecs(agent)[0]!;
      return [
        agent,
        {
          contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
          agent,
          ready: true,
          verificationKind: spec.verificationKind,
          endpoint: 'credential-probe',
          exitStatus: 0,
          observedAt,
          ...(spec.subjectDisclosure === 'redacted' ? { subject: 'authenticated' } : {}),
          proofDigest: `${agent}-proof`,
          subjectDisclosure: spec.subjectDisclosure,
        },
      ];
    }),
  );
  return {
    contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
    sourceKind: 'operator-integration-credentials',
    binding: {
      channel: 'agent',
      family: 'agent-encrypted-reference',
      generation: AGENT_GENERATION,
      referenceDigest: workspaceHostCredentialReferenceDigest(AGENT_REF),
    },
    observedAt,
    verification: {
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      observedAt,
      allReady: true,
      agents: agents as WorkspaceHostAgentCredentialAdmissionEvidence['verification']['agents'],
      credentialFreeAgents: [],
      unfundedAgents: [],
      admissible: true,
    },
  };
}

interface ReadinessRunnerOptions {
  readonly head?: string;
  readonly origin?: string;
  readonly submodules?: string;
  readonly ambientHelper?: string;
  readonly mutateCredential?: boolean;
}

function readinessRunner(options: ReadinessRunnerOptions = {}) {
  const calls: GcpImageFamilyCommand[] = [];
  const runner: GcpImageFamilyCommandRunner = {
    async run(commandOrObject, args = [], invocation = {}) {
      const command =
        typeof commandOrObject === 'string' ? { command: commandOrObject, args, ...invocation } : commandOrObject;
      calls.push(command);
      const signature = command.args.join(' ');
      if (signature.endsWith('config --get-all credential.helper')) {
        return options.ambientHelper
          ? { exitCode: 0, stdout: `${options.ambientHelper}\n`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' };
      }
      if (signature.endsWith('rev-parse HEAD')) {
        return { exitCode: 0, stdout: `${options.head ?? SOURCE_REVISION}\n`, stderr: '' };
      }
      if (signature.endsWith('remote get-url origin')) {
        return {
          exitCode: 0,
          stdout: `${options.origin ?? 'https://github.com/Papercusp/papercusp.git'}\n`,
          stderr: '',
        };
      }
      if (signature.endsWith('submodule status --recursive')) {
        return {
          exitCode: 0,
          stdout: options.submodules ?? ` ${GITLINK_REVISION} libs/papercusp (heads/staging)\n`,
          stderr: '',
        };
      }
      if (signature === 'credential fill') {
        return {
          exitCode: 0,
          stdout:
            'protocol=https\nhost=github.com\npath=Papercusp/papercusp.git\n' +
            'username=git-user\npassword=private-token-value\n',
          stderr: '',
        };
      }
      if (signature === 'credential approve' || signature === 'credential reject') {
        if (options.mutateCredential && signature === 'credential approve') {
          const materialPath = command.env?.GIT_CONFIG_VALUE_1?.match(/--file='([^']+)'/)?.[1];
          if (materialPath) {
            await writeFile(materialPath, 'https://git-user:changed-value@github.com/Papercusp/papercusp.git\n');
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (signature.startsWith('ls-remote --exit-code ')) {
        return { exitCode: 0, stdout: `${SOURCE_REVISION}\tHEAD\n`, stderr: '' };
      }
      return { exitCode: 127, stdout: '', stderr: `unexpected command: ${signature}` };
    },
  };
  return { runner, calls };
}

function readinessDependencies(
  options: {
    readonly runner?: GcpImageFamilyCommandRunner;
    readonly runtime?: Partial<
      Awaited<ReturnType<NonNullable<GcpImageFamilyExactPathReadinessDependencies['inspectRuntime']>>>
    >;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly now?: Date;
    readonly verifyAgent?: GcpImageFamilyExactPathReadinessDependencies['verifyAgentCredentialAdmission'];
  } = {},
): GcpImageFamilyExactPathReadinessDependencies {
  return {
    commandRunner: options.runner ?? readinessRunner().runner,
    materialSource: {
      async resolve(request) {
        if (request.channel !== 'git') throw new Error('agent material is handled by the admission seam');
        return new WorkspaceHostCredentialMaterial(Buffer.from(GIT_MATERIAL));
      },
    },
    verifyAgentCredentialAdmission: options.verifyAgent ?? (async () => agentAdmission()),
    inspectRuntime: async () => ({
      username: 'release-user',
      cwd: '/repo',
      freeBytes: 1_000,
      freeInodes: 100,
      missingRetainedPaths: [],
      ...options.runtime,
    }),
    now: () => options.now ?? READINESS_NOW,
    environment: options.environment ?? { PATH: '/usr/bin:/bin' },
  };
}

describe('GCP image-family exact-path readiness', () => {
  it('builds a closed public config from whitelisted input plus producer-captured identity and cwd', () => {
    const raw = readinessRaw();
    const config = buildGcpImageFamilyExactPathReadinessConfig(
      {
        credentials: raw.credentials,
        storage: raw.storage,
        sourceGitlinks: raw.source.gitlinks,
        ignoredAssertion: 'not-forwarded',
      },
      {
        username: 'release-user',
        cwd: '/canonical/repo',
        source: {
          repository: raw.source.repository,
          revision: raw.source.revision,
        },
        requestedAt: raw.requestedAt,
      },
    );
    expect(config.expected).toEqual({ username: 'release-user', cwd: '/canonical/repo' });
    expect(config.source.gitlinks).toEqual(raw.source.gitlinks);
    expect(config).not.toHaveProperty('ignoredAssertion');
    expect(JSON.stringify(config)).not.toContain('private-token-value');
    expect(() => parseGcpImageFamilyExactPathReadinessConfig(config)).not.toThrow();
    expect(() =>
      buildGcpImageFamilyExactPathReadinessConfig(
        {
          credentials: raw.credentials,
          storage: raw.storage,
          sourceGitlinks: raw.source.gitlinks,
          apiToken: 'must-not-be-silently-dropped',
        },
        {
          username: 'release-user',
          cwd: '/canonical/repo',
          source: raw.source,
          requestedAt: raw.requestedAt,
        },
      ),
    ).toThrow(/Secret-shaped field/);
  });

  it('passes the valid exact path and returns only redacted public evidence', async () => {
    const { runner, calls } = readinessRunner();
    const verifyAgent = vi.fn(async () => agentAdmission());
    const evidence = await verifyGcpImageFamilyExactPathReadiness(
      readinessRaw(),
      readinessDependencies({ runner, verifyAgent }),
    );
    expect(evidence).toMatchObject({
      ok: true,
      identity: { username: 'release-user', cwd: '/repo' },
      bindings: {
        git: { generation: GIT_GENERATION, repositoryScope: 'exact', materialImmutable: true },
        agent: { generation: AGENT_GENERATION, authenticated: true },
      },
      source: { revision: SOURCE_REVISION, gitlinkCount: 1 },
    });
    expect(calls.map((call) => call.args.join(' '))).toEqual(
      expect.arrayContaining([
        'credential fill',
        'credential approve',
        'credential reject',
        'ls-remote --exit-code https://github.com/Papercusp/papercusp.git HEAD',
      ]),
    );
    expect(JSON.stringify(evidence)).not.toContain('private-token-value');
    expect(JSON.stringify(evidence)).not.toContain(GIT_REF);
    expect(JSON.stringify(evidence)).not.toContain(AGENT_REF);
    expect(verifyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: expect.objectContaining({ generation: AGENT_GENERATION }),
      }),
    );
  });

  it.each([
    {
      name: 'revoked Git generation',
      code: 'revoked-credential',
      arrange: () => {
        const raw = readinessRaw();
        raw.credentials.git.revokedThrough = GIT_GENERATION;
        return { raw, deps: readinessDependencies() };
      },
    },
    {
      name: 'expired Git generation',
      code: 'expired-credential',
      arrange: () => {
        const raw = readinessRaw();
        raw.credentials.git.delivery.expiresAt = '2026-09-07T13:00:00.000Z';
        return {
          raw,
          deps: readinessDependencies({ now: new Date('2026-09-07T14:00:00.000Z') }),
        };
      },
    },
    {
      name: 'wrong repository credential',
      code: 'wrong-repository',
      arrange: () => {
        const raw = readinessRaw();
        raw.credentials.git.credentialRef.ref = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
          forge: 'github',
          owner: 'Papercusp',
          repository: 'other',
        });
        raw.credentials.git.delivery.revocationRef = buildWorkspaceHostCredentialRevocationReference(
          'git-short-lived-delegation',
          { forge: 'github', owner: 'Papercusp', repository: 'other' },
          GIT_GENERATION,
        );
        return { raw, deps: readinessDependencies() };
      },
    },
    {
      name: 'root identity',
      code: 'wrong-identity',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runtime: { username: 'root' } }),
      }),
    },
    {
      name: 'wrong cwd',
      code: 'wrong-cwd',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runtime: { cwd: '/other' } }),
      }),
    },
    {
      name: 'low free bytes',
      code: 'insufficient-storage',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runtime: { freeBytes: 99 } }),
      }),
    },
    {
      name: 'low free inodes',
      code: 'insufficient-storage',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runtime: { freeInodes: 9 } }),
      }),
    },
    {
      name: 'missing retained state',
      code: 'missing-retained-state',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runtime: { missingRetainedPaths: ['.papercusp/state'] } }),
      }),
    },
    {
      name: 'ambient helper environment',
      code: 'ambient-git-helper',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({
          environment: { PATH: '/usr/bin:/bin', GIT_ASKPASS: '/tmp/ambient-helper' },
        }),
      }),
    },
    {
      name: 'ambient configured helper',
      code: 'ambient-git-helper',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({
          runner: readinessRunner({ ambientHelper: 'store --file=/tmp/ambient' }).runner,
        }),
      }),
    },
    {
      name: 'mismatched HEAD',
      code: 'source-revision-mismatch',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({ runner: readinessRunner({ head: '3'.repeat(40) }).runner }),
      }),
    },
    {
      name: 'mismatched origin',
      code: 'source-origin-mismatch',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({
          runner: readinessRunner({ origin: 'https://github.com/Papercusp/other.git' }).runner,
        }),
      }),
    },
    {
      name: 'mismatched gitlink',
      code: 'gitlink-mismatch',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({
          runner: readinessRunner({
            submodules: ` ${'4'.repeat(40)} libs/papercusp (heads/staging)\n`,
          }).runner,
        }),
      }),
    },
    {
      name: 'write-capable Git helper',
      code: 'git-helper-write',
      arrange: () => ({
        raw: readinessRaw(),
        deps: readinessDependencies({
          runner: readinessRunner({ mutateCredential: true }).runner,
        }),
      }),
    },
  ])('rejects $name before the exact Git or agent probes complete', async ({ code, arrange }) => {
    const { raw, deps } = arrange();
    let rejection: unknown;
    try {
      await verifyGcpImageFamilyExactPathReadiness(raw, deps);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(GcpImageFamilyExactPathReadinessError);
    expect(rejection).toMatchObject({ code });
    expect(JSON.stringify(rejection)).not.toContain('private-token-value');
  });

  it('uses real Git credential fill/approve/reject while keeping the generation byte-identical', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'gcp-readiness-repository-'));
    const fake = readinessRunner();
    const real = new NodeGcpImageFamilyCommandRunner();
    const protocolSnapshots: Buffer[] = [];
    const runner: GcpImageFamilyCommandRunner = {
      async run(commandOrObject, args = [], invocation = {}) {
        const command =
          typeof commandOrObject === 'string' ? { command: commandOrObject, args, ...invocation } : commandOrObject;
        if (command.args[0] !== 'credential') return fake.runner.run(command);
        const result = await real.run(command);
        const helper = command.env?.GIT_CONFIG_VALUE_1;
        const materialPath = helper?.match(/--file='([^']+)'/)?.[1];
        if (materialPath) protocolSnapshots.push(await readFile(materialPath));
        return result;
      },
    };
    try {
      const raw = readinessRaw();
      raw.expected.cwd = repositoryRoot;
      const evidence = await verifyGcpImageFamilyExactPathReadiness(
        raw,
        readinessDependencies({ runner, runtime: { cwd: repositoryRoot } }),
      );
      expect(evidence.bindings.git.materialImmutable).toBe(true);
      expect(protocolSnapshots).toHaveLength(3);
      for (const snapshot of protocolSnapshots) expect(snapshot).toEqual(GIT_MATERIAL);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});
