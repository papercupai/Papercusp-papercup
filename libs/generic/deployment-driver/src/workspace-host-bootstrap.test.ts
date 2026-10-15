import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BWRAP_USERNS_GRANT_FUNCTION } from './bwrap-userns-grant';
import { ZRAM_GENERATOR_APT_PACKAGE, ZRAM_SWAP_FUNCTION } from './zram-swap';
import {
  DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
  WORKSPACE_HOST_APT_FETCH_TIMEOUT_SEC,
  WORKSPACE_HOST_APT_UPDATE_TIMEOUT_SEC,
  WORKSPACE_HOST_CURL_STALL_GUARD,
  WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES,
  WORKSPACE_HOST_BOOTSTRAP_SHARED_CHECKS,
  WORKSPACE_HOST_MODELS,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTC_RUNTIME_READ_GROUP,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
  WORKSPACE_HOST_BOOTC_RELEASE_REGISTRY_SCOPE_PATH,
  WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET,
  WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL,
  WORKSPACE_HOST_BOOTSTRAP_STAGED_PREFIX,
  WORKSPACE_HOST_UPDATE_MODE_BY_MODEL,
  workspaceHostBootstrapChecks,
  WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_PHASES,
  WORKSPACE_HOST_AGENT_NODE_SHA256,
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
  customerTscServiceInstallLines,
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT,
  WORKSPACE_HOST_AGENT_NODE_VERSION,
  WORKSPACE_HOST_OLLAMA_SHA256,
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM,
  WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE,
  WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS,
  WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
  WORKSPACE_HOST_GLIBC_SONAMES,
  WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE,
  WORKSPACE_HOST_RUNTIME_ROOT,
  WORKSPACE_HOST_STATE_ROOT,
  WORKSPACE_HOST_HOSTED_PTY_SSH_KEY,
  WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS,
  buildWorkspaceHostBootstrap,
  evaluateWorkspaceHostNativeDependencyCoverage,
  normalizeWorkspaceHostSoname,
  parseWorkspaceHostReadelfNeeded,
  parseWorkspaceHostBootstrapAttestation,
  validateWorkspaceHostBootstrapAttestation,
  workspaceHostBootcPinnedImageRef,
  type WorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapInput,
} from "./workspace-host-bootstrap";
// Imported from the PROBE's own module, not restated: the assertions below check that the
// installer stages exactly what the probe asks for, which only means something if both sides
// read the same constant.
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from './workspace-host-agent-authentication';
import { WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML } from './workspace-host-agent-home';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
  WORKSPACE_HOST_ARTIFACT_ORIGIN,
  WORKSPACE_HOST_ARTIFACT_PATH_PREFIX,
} from './workspace-host-build-manifest';

/**
 * Composed from the shipped constants rather than hardcoded, so these fixtures cannot drift off
 * the real origin — and so no account-bearing hostname is reintroduced into source (WI-38321).
 */
const ARTIFACT_BASE = `${WORKSPACE_HOST_ARTIFACT_ORIGIN}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}`;
import { WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV } from './workspace-host-remote-initializer';
import { WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV } from './workspace-host-credential-delivery';

const DIGEST = 'a'.repeat(64);
const KEY_DIGEST = 'b'.repeat(64);
const OTHER_DIGEST = 'c'.repeat(64);

// D-106: fixtures derive their URLs from the digest instead of hand-authoring one. The previous
// literals pointed at releases.papercusp.com, which D-105 established has no production source or
// DNS — so every fixture in this file was teaching an address that cannot exist.
const ARTIFACTS = deriveWorkspaceHostCanonicalArtifactUrls(DIGEST);

function input(
  overrides: Partial<WorkspaceHostBootstrapInput> = {},
): WorkspaceHostBootstrapInput {
  return {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId: 'host-1',
    release: {
      version: '2026.8.22-1',
      bundleUrl: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signatureUrl: ARTIFACTS.signatureUrl,
      signingPublicKey:
        'untrusted comment: Papercusp release key\nRWQpublickey',
      signingKeySha256: KEY_DIGEST,
    },
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
    workspaceAuthorizedKeys: [
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller',
    ],
    publicMetadata: { channel: 'canary' },
    ...overrides,
  };
}

// Pinned to ONE member rather than the union. `Partial<A | B>` distributes to
// `Partial<A> | Partial<B>`, so a spread of it yields a union in which every model-specific field
// is optional — which would let a fixture drop `updateMode` or `ubuntuVersion` and still compile,
// silently weakening the very tests that exist to catch a malformed attestation.
type UbuntuAttestation = Extract<
  WorkspaceHostBootstrapAttestation,
  { hostModel: 'ubuntu-release-bundle' }
>;
type BootcAttestation = Extract<
  WorkspaceHostBootstrapAttestation,
  { hostModel: 'bootc-image' }
>;

// Returns the CONCRETE member, not the union: callers spread `attestation().isolation` to build
// near-miss documents, and off a union every one of those spreads is itself a union with no
// single `updateMode`. The validator takes `unknown`, so nothing is weakened by being specific.
function attestation(
  overrides: Partial<UbuntuAttestation> = {},
): UbuntuAttestation {
  return {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    hostId: 'host-1',
    action: 'install',
    hostModel: 'ubuntu-release-bundle',
    ubuntuVersion: '24.04',
    observedAt: '2026-08-22T06:00:00Z',
    status: 'healthy',
    release: {
      version: '2026.8.22-1',
      source: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signingKeySha256: KEY_DIGEST,
      signatureVerified: true,
    },
    migration: { id: 'schema-1042', applied: true },
    runtime: {
      nodeMajor: 22,
      minimumNodeMajor: 22,
      psu: true,
      pui: true,
      agentLaunchers: { claude: true, codex: true, omp: true },
      agentRuntimesVerifiedByBootstrap: false,
      agentRuntimesInstalledByBootstrap: false,
    },
    service: {
      name: 'papercusp-workspace',
      user: DEFAULT_WORKSPACE_HOST_SERVICE_USER,
      group: DEFAULT_WORKSPACE_HOST_SERVICE_USER,
      bindHost: '127.0.0.1',
      port: 3070,
      active: true,
    },
    isolation: {
      workspaceUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      workspaceGroup: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      agentUser: DEFAULT_WORKSPACE_HOST_AGENT_USER,
      agentGroup: DEFAULT_WORKSPACE_HOST_AGENT_USER,
      runtimeRoot: WORKSPACE_HOST_RUNTIME_ROOT,
      stateRoot: WORKSPACE_HOST_STATE_ROOT,
      workspaceRoot: WORKSPACE_HOST_DATA_ROOT,
      runtimeReadableByWorkspaceUser: false,
      runtimeWritableByWorkspaceUser: false,
      runtimeReadableByAgentUser: true,
      runtimeWritableByAgentUser: false,
      agentHomeReadableBySshUser: false,
      workspaceWritableByService: true,
      workspaceWritableBySshUser: true,
      workspaceWritableByAgentUser: true,
      sudo: false,
      serviceGroupMember: false,
      operatorIngress: 'ssh-local-forward',
      updateMode: 'signed-atomic-release-swap',
    },
    checks: workspaceHostBootstrapChecks('ubuntu-release-bundle').map(
      (name) => ({ name, ok: true as const }),
    ),
    ...overrides,
  };
}

/** A bootc render input. `bootc` is required by validateInput whenever the model is bootc. */
function bootcInput(
  overrides: Partial<WorkspaceHostBootstrapInput> = {},
): WorkspaceHostBootstrapInput {
  return {
    ...input(),
    hostModel: 'bootc-image',
    bootc: {
      image: 'registry.example.com/papercusp/workspace-host:2026.9.4-1',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: '/etc/containers/policy.json',
    },
    ...overrides,
  };
}

/**
 * D-259 fixtures. Byte-sized stand-ins for the real vendor install argvs — what is under test is
 * how the bootstrap RUNS and VERIFIES them, never what the vendor scripts themselves do.
 */
const AGENT_RUNTIME_INSTALLS = [
  { agent: 'claude', command: 'bash', args: ['-c', 'echo install-claude'] },
  { agent: 'codex', command: 'bash', args: ['-c', 'echo install-codex'] },
  { agent: 'omp', command: 'bash', args: ['-c', 'echo install-omp'] },
] as const;

describe('buildWorkspaceHostBootstrap agent runtime installs (D-259)', () => {
  it('installs nothing and attests the negative when no installs are configured', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain('AGENT_RUNTIME_PATH');
    expect(script).toContain('agentRuntimesInstalledByBootstrap:false');
    expect(script).not.toContain('agentRuntimes:{');
  });

  it('runs each install as the AGENT identity and dies if the runtime does not resolve', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    for (const { agent } of AGENT_RUNTIME_INSTALLS) {
      // Installed as the agent identity, in the agent's own home. Every argv element is
      // individually quoted, so a vendor install script containing spaces or shell
      // metacharacters cannot word-split into extra arguments.
      expect(script).toContain(
        `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" 'bash' '-c' 'echo install-${agent}' || die 'agent runtime install failed: ${agent}'`,
      );
      // ...and then RESOLVED, with a die on absence. An install that exits 0 while leaving
      // nothing on disk is the unbacked boolean this whole item exists to remove.
      expect(script).toContain(
        `[[ -n "$AGENT_RUNTIME_${agent.toUpperCase()}" ]] || die 'agent runtime did not resolve after install: ${agent}'`,
      );
    }
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('gives the customer native OMP and the credential-free local model without the agent home', () => {
    const script = buildWorkspaceHostBootstrap(input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }));
    const resolve = script.indexOf('AGENT_RUNTIME_OMP="$(runuser');
    const publish = script.indexOf('install -m 0755 -o root -g root -- "$AGENT_RUNTIME_OMP" /usr/local/bin/omp');
    expect(resolve).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(resolve);
    expect(script).toContain('[[ "$AGENT_RUNTIME_OMP" == "$AGENT_HOME/.local/bin/omp" && -f "$AGENT_RUNTIME_OMP" && ! -L "$AGENT_RUNTIME_OMP" ]]');
    expect(script).toContain(Buffer.from(WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML).toString('base64'));
    expect(script).toContain('runuser -u "$WORKSPACE_USER" -- env HOME="/home/$WORKSPACE_USER"');
    expect(script).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME"');
    expect(buildWorkspaceHostBootstrap(input())).not.toContain('customer OMP model registry install failed');
  });

  /**
   * D-423 (WI-10003195). Customer-driven agents run as the workspace account, which D-043 bars from
   * the Papercusp runtime, so their Node and agent CLIs come from a root-owned toolchain OUTSIDE the
   * runtime root. What must hold: it is published only after the vendor runtimes resolved, it copies
   * from the agent identity's installs (never the release tree), it refuses to publish a credential,
   * and the verify half proves the customer can execute it while still unable to read the release.
   */
  it('publishes a customer agent toolchain outside the runtime root and verifies it as the customer (D-423)', () => {
    const script = buildWorkspaceHostBootstrap(input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }));
    expect(WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT.startsWith('/opt/papercusp')).toBe(false);
    expect(WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN).toBe(`${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT}/bin`);
    expect(script).toContain(`TOOLCHAIN_ROOT='${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT}'`);

    // Ordered after every resolve AND after the OMP publish it links to.
    const lastResolve = script.lastIndexOf('agent runtime did not resolve after install');
    const ompPublish = script.indexOf('/usr/local/bin/omp', script.indexOf('AGENT_RUNTIME_OMP="$(runuser'));
    const toolchainAt = script.indexOf('TOOLCHAIN_ROOT=');
    expect(lastResolve).toBeGreaterThan(-1);
    expect(toolchainAt).toBeGreaterThan(lastResolve);
    expect(toolchainAt).toBeGreaterThan(ompPublish);

    // Copies FROM the agent identity's own installs, root-owned; never from the release tree.
    expect(script).toContain('install -m 0755 -o root -g root -- "$AGENT_HOME/.local/bin/node" "$TOOLCHAIN_NEXT/bin/node"');
    expect(script).toContain('cp -R -P -- "$AGENT_HOME/.papercusp/runtime/node_modules" "$TOOLCHAIN_NEXT/codex/node_modules"');
    expect(script).toContain('install -m 0755 -o root -g root -- "$CLAUDE_REAL" "$TOOLCHAIN_NEXT/bin/claude"');
    expect(script).toContain('ln -s /usr/local/bin/omp "$TOOLCHAIN_NEXT/bin/omp"');
    const section = script.slice(toolchainAt, script.indexOf('customer agent toolchain path exposes the platform agent home'));
    // The ONLY release-tree reads are D-031's two heavy-admission scripts, COPIED root-owned
    // by `install` (never linked, so the customer never needs to read the release tree).
    const releaseLines = section.split('\n').filter((line) => line.includes('RELEASE_DIR/'));
    expect(releaseLines.length).toBeGreaterThan(0);
    for (const line of releaseLines) {
      expect(line).toMatch(/^\s*(if \[\[ -f "\$RELEASE_DIR\/scripts\/heavy-admission\.cjs" && -f "\$RELEASE_DIR\/scripts\/pc-heavy\.sh" \]\]; then|install -m 0\d{3} -o root -g root -- "\$RELEASE_DIR\/scripts\/(heavy-admission\.cjs|pc-heavy\.sh)" "\$TOOLCHAIN_NEXT\/lib\/heavy-admission\/[a-z.-]+")$/);
    }
    expect(section).not.toMatch(/ln -s[^\n]*RELEASE_DIR/);
    expect(section).toContain('chown -R -h root:root -- "$TOOLCHAIN_NEXT"');
    expect(section).toContain('die "customer agent toolchain would publish an agent credential file"');
    // Swapped in whole, never edited in place.
    expect(section).toContain('mv -T -- "$TOOLCHAIN_NEXT" "$TOOLCHAIN_ROOT"');

    // Verify half: the customer executes each CLI, and still cannot read the release or agent home.
    for (const cli of ['node', 'codex', 'claude']) {
      expect(script).toContain(
        `runuser -u "$WORKSPACE_USER" -- env HOME="/home/$WORKSPACE_USER" PATH="$TOOLCHAIN_ROOT/bin:/usr/local/bin:/usr/bin:/bin" timeout 120 ${cli} --version >/dev/null`,
      );
    }
    expect(script).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r "$RELEASE_DIR" || die "customer account can read the Papercusp release (D-043)"');

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  // WI-10005296 (D-031 ruling 2): the toolchain carries the heavy-job admission pair when the
  // release has both files, inside the staged toolchain (so the credential scan and the root
  // chown/chmod cover it), and the log says which way it went.
  it('publishes the heavy-job admission pair into the staged toolchain only when the release carries both', () => {
    const script = buildWorkspaceHostBootstrap(input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }));
    const guard = script.indexOf('if [[ -f "$RELEASE_DIR/scripts/heavy-admission.cjs" && -f "$RELEASE_DIR/scripts/pc-heavy.sh" ]]; then');
    expect(guard).toBeGreaterThan(script.indexOf('TOOLCHAIN_NEXT="$TOOLCHAIN_ROOT.next"'));
    expect(guard).toBeLessThan(script.indexOf('chown -R -h root:root -- "$TOOLCHAIN_NEXT"'));
    expect(script).toContain('"$TOOLCHAIN_NEXT/lib/heavy-admission/heavy-admission.cjs"');
    expect(script).toContain('install -m 0755 -o root -g root -- "$RELEASE_DIR/scripts/pc-heavy.sh" "$TOOLCHAIN_NEXT/lib/heavy-admission/pc-heavy.sh"');
    expect(script).toContain('PAPERCUSP_HEAVY_ADMISSION status=installed');
    expect(script).toContain('PAPERCUSP_HEAVY_ADMISSION status=absent');
  });

  // WI-10005362: the shared typecheck service's user template units, written by the real lines
  // into a temp unit dir against a fake /proc/meminfo (root-only install/chown shimmed).
  describe('shared typecheck service template units', () => {
    function runLines(memTotalKiB: number, preexisting = false) {
      const dir = mkdtempSync(join(tmpdir(), 'tsc-units-'));
      const unitDir = join(dir, 'user');
      const meminfo = join(dir, 'meminfo');
      writeFileSync(meminfo, `MemTotal:       ${memTotalKiB} kB\nMemFree:        1 kB\n`);
      if (preexisting) {
        mkdirSync(unitDir);
        writeFileSync(join(unitDir, 'papercusp-tsc-service@.socket'), 'old');
        writeFileSync(join(unitDir, 'papercusp-tsc-service@.service'), 'old');
      }
      const script = [
        'set -euo pipefail',
        'install() { mkdir -p -- "${@: -1}"; }',
        'chown() { :; }',
        'TOOLCHAIN_ROOT=/usr/local/lib/papercusp-agent-toolchain',
        ...customerTscServiceInstallLines({ unitDir, meminfo }),
      ].join('\n');
      const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      const read = (name: string) => {
        try {
          return readFileSync(join(unitDir, name), 'utf8');
        } catch {
          return null;
        }
      };
      const out = { run, socket: read('papercusp-tsc-service@.socket'), service: read('papercusp-tsc-service@.service') };
      rmSync(dir, { recursive: true, force: true });
      return out;
    }

    it('installs a per-checkout socket + service sized from host RAM on a 64 GB host', () => {
      const { run, socket, service } = runLines(65_843_000);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('PAPERCUSP_TSC_SERVICE status=installed memoryMaxGiB=15 maxProjects=2');
      expect(socket).toContain('ListenStream=%t/papercusp-tsc-service-%i.sock');
      expect(socket).toContain('SocketMode=0600');
      expect(service).toContain('ExecStart=/usr/local/lib/papercusp-agent-toolchain/bin/node %f/scripts/tsc-service/server.mjs');
      expect(service).toContain('Environment=PAPERCUSP_TSC_SERVICE_ROOT=%f');
      expect(service).toContain('ConditionPathExists=%f/scripts/tsc-service/server.mjs');
      expect(service).toContain('Requires=papercusp-tsc-service@%i.socket');
      expect(service).toMatch(/^MemoryHigh=13G$/m);
      expect(service).toMatch(/^MemoryMax=15G$/m);
      expect(service).toMatch(/^Environment=PAPERCUSP_TSC_SERVICE_RSS_RESET_GIB=11$/m);
      expect(service).not.toContain('$');
    });

    it('caps the service at 16 GiB and one project below 56 GiB', () => {
      expect(runLines(268_435_456).service).toMatch(/^MemoryMax=16G$/m);
      const small = runLines(33_554_432);
      expect(small.service).toMatch(/^MemoryMax=10G$/m);
      expect(small.service).toMatch(/^Environment=PAPERCUSP_TSC_SERVICE_MAX_PROJECTS=1$/m);
    });

    it('removes previously installed units on a host under 24 GiB, so the operator stops advertising them', () => {
      const { run, socket, service } = runLines(16_384_000, true);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('PAPERCUSP_TSC_SERVICE status=absent reason=host-memory-below-24GiB memTotalGiB=15');
      expect(socket).toBeNull();
      expect(service).toBeNull();
    });

    it('runs after the toolchain is in place, inside the customer toolchain block', () => {
      const script = buildWorkspaceHostBootstrap(input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }));
      expect(script.indexOf('PAPERCUSP_TSC_SERVICE status=installed')).toBeGreaterThan(script.indexOf('mv -T -- "$TOOLCHAIN_NEXT" "$TOOLCHAIN_ROOT"'));
      expect(buildWorkspaceHostBootstrap(input())).not.toContain('PAPERCUSP_TSC_SERVICE status=');
    });
  });

  it('publishes no customer agent toolchain on a host that installs no vendor runtime', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain('TOOLCHAIN_ROOT=');
    expect(script).not.toContain('customer cannot execute codex from the agent toolchain');
  });

  it('publishes only the toolchain entries for the agents actually installed', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: AGENT_RUNTIME_INSTALLS.filter((install) => install.agent === 'codex') }),
    );
    expect(script).toContain('ln -s ../codex/node_modules/.bin/codex "$TOOLCHAIN_NEXT/bin/codex"');
    expect(script).not.toContain('CLAUDE_REAL=');
    expect(script).not.toContain('"$TOOLCHAIN_NEXT/bin/omp"');
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  /**
   * THE REGRESSION THIS FILE MOST NEEDS. `$RELEASE_DIR/bin` holds the psu WRAPPERS named
   * `claude`/`codex`/`omp`. If it were on the resolve PATH, `command -v claude` would find a
   * wrapper and report success on a host with no vendor runtime at all — which is exactly the
   * confusion that made D-247 read as a probe bug for three sessions.
   */
  it('resolves against dirs the installers write to, never the release bin holding the psu wrappers', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const pathLine = script
      .split('\n')
      .find((line) => line.startsWith('AGENT_RUNTIME_PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('$AGENT_HOME/.local/bin');
    expect(pathLine).toContain('$AGENT_HOME/.papercusp/runtime/node_modules/.bin');
    expect(pathLine).not.toContain('RELEASE_DIR');
    expect(pathLine).not.toContain('RUNTIME_ROOT');
  });

  /**
   * D-263. The codex install argv is the DESKTOP onboarding script and it shells `npm`, which this
   * host has nowhere: not in the apt contract, and not in the bundle (a bare `node`, no npm). That
   * killed bootstrap before the initialize entrypoint was installed, surfacing as every canary
   * failing `0/6` with `exit 127 ... papercusp-workspace-host-initialize: No such file or directory`
   * — an error naming the wrong artifact entirely. These assertions pin the repair.
   */
  it('installs a pinned Node into the agent home BEFORE any vendor install that needs npm', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    // Runs as the AGENT identity, in the agent's own home — not as root, and not into the
    // root-owned release tree the agent only holds rX on.
    expect(script).toContain(
      `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" /bin/bash -c '`,
    );
    expect(script).toContain(
      `|| die 'agent Node runtime install failed (v${WORKSPACE_HOST_AGENT_NODE_VERSION})'`,
    );
    // ORDERING IS THE WHOLE POINT: npm has to exist before codex's installer runs, so a node
    // install emitted after the loop would reproduce the original failure exactly.
    const nodeAt = script.indexOf('installing agent Node runtime');
    const codexAt = script.indexOf("'echo install-codex'");
    expect(nodeAt).toBeGreaterThan(-1);
    expect(codexAt).toBeGreaterThan(-1);
    expect(nodeAt).toBeLessThan(codexAt);
  });

  it('pins the Node tarball by version AND checksum, and verifies npm survived the extract', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain(
      `https://nodejs.org/dist/v${WORKSPACE_HOST_AGENT_NODE_VERSION}/$dir.tar.gz`,
    );
    // The digest is the trust boundary — a swapped upstream tarball must fail rather than execute.
    expect(script).toContain(WORKSPACE_HOST_AGENT_NODE_SHA256.x64);
    expect(script).toContain(WORKSPACE_HOST_AGENT_NODE_SHA256.arm64);
    expect(script).toContain('sha256sum -c -');
    // .tar.gz, never .tar.xz: the apt contract deliberately ships no xz-utils.
    expect(script).not.toContain('.tar.xz');
    expect(WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES).not.toContain('xz-utils');
    // npm is a symlink into lib/, so asserting only `node` would pass on an extract that leaves
    // npm dangling — the failure would then land inside the codex install and read as codex's bug.
    expect(script).toContain('"$target/bin/npm" --version >/dev/null');
  });

  /**
   * D-266. OMP is credential-free by contract (D-245), and the OTHER half of that contract is
   * that it proves readiness by LOCAL INFERENCE. Nothing implemented that half, so `omp` could
   * never pass and canary-09 stopped at 5/6 with a failure that read as a credential fault.
   */
  it('installs the pinned local-inference runtime and the exact model the OMP probe requests', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    // The pin is the trust boundary for a ROOT install, exactly as the Node runtime pin is.
    expect(script).toContain(WORKSPACE_HOST_OLLAMA_SHA256.x64);
    expect(script).toContain(WORKSPACE_HOST_OLLAMA_SHA256.arm64);
    expect(script).toContain(
      '|| die "local-inference runtime digest mismatch"',
    );
    // The GPU bundles are 2.0G of a 2.1G install and are dead weight on a CPU-only host.
    expect(script).toContain('--exclude="lib/ollama/cuda_v*"');
    expect(script).toContain('--exclude="lib/ollama/vulkan"');
    // THE MODEL IS ONE FACT, NOT TWO. The installer pulls whatever the probe asks for, so this
    // asserts the shared constant reaches the script rather than re-typing the tag — a second
    // copy is what silently leaves a host pulling one model and failing a probe wanting another.
    expect(script).toContain(`ollama pull '${WORKSPACE_HOST_OMP_LOCAL_MODEL}'`);
    expect(script).toContain(
      `ollama show '${WORKSPACE_HOST_OMP_LOCAL_MODEL}'`,
    );
  });

  /**
   * MEASURED on canary-11 (2026-09-03): a GCE startup-script runs as root with NO $HOME, and the
   * ollama CLI panics in `envconfig.Models()` (config.go:120) from `NewCLI()` — BEFORE any
   * subcommand runs — when it is unset:
   *
   *     panic: $HOME is not defined
   *
   * That is a whole class, not one call: it took down `ollama pull` (canary-10's undiagnosable
   * 26ms failure) and it silently defeated the version guard too, because `ollama --version`
   * panicked to empty stdout so the comparison never matched and the runtime was re-downloaded
   * on every boot. So the guard is "every CLI invocation carries HOME", enumerated from the
   * rendered script rather than spot-checked — a NEW ollama CLI call added without HOME fails
   * here instead of on a host. The SERVER is deliberately exempt: systemd derives HOME from
   * `User=`, which is why this is a CLI-only fix and not a global export.
   */
  it('gives every ollama CLI invocation a HOME, since a startup-script has none', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain('OLLAMA_CLI_HOME="${HOME:-/root}"');

    const cliInvocations = script
      .split('\n')
      .filter(
        (line) =>
          // RUNNING the binary with a subcommand — not `[[ -x /usr/local/bin/ollama ]]`, which
          // is a file test that starts no process and therefore needs no environment.
          /\/usr\/local\/bin\/ollama\s+(--version|pull|show)\b/.test(line) &&
          // The systemd unit's own ExecStart is the server, not the CLI.
          !line.includes('ExecStart='),
      );
    // A calibration case: if this ever selects nothing, the assertion below would pass
    // vacuously and report a fixed script as safe.
    expect(cliInvocations.length).toBeGreaterThanOrEqual(3);
    for (const line of cliInvocations) {
      expect(line).toContain('HOME="$OLLAMA_CLI_HOME"');
    }

    // HOME must be defined before the first invocation that relies on it.
    expect(script.indexOf('OLLAMA_CLI_HOME="${HOME:-/root}"')).toBeLessThan(
      script.indexOf('HOME="$OLLAMA_CLI_HOME"'),
    );
  });

  /**
   * canary-12 (2026-09-03). The script sets `umask 027`, and tar creates a parent directory it
   * was not given an explicit entry for using that umask — so `/usr/local/lib/ollama` came out
   * `drwxr-x--- root root` and the `ollama` SERVICE ACCOUNT could not traverse its own runtime.
   * The server started fine (it could exec the 0755 binary) and then reported `llama-server
   * binary not found` for a path that existed, which is what a directory the process cannot
   * traverse looks like from inside.
   *
   * The guard is ordering plus reach: the normalization must run AFTER the extraction that
   * creates the tree, and OUTSIDE the install `if`, so a host already carrying a 0750 tree
   * self-heals instead of staying broken because its version matched. Root's own `[[ -x ]]`
   * assertion cannot catch this — root bypasses directory permission bits — which is exactly
   * why the check has to live in the rendered script rather than in that assertion.
   */
  it('makes the ollama runtime tree traversable by the non-root service account', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const lines = script.split('\n');

    const normalizeAt = lines.findIndex((line) =>
      /^chmod -R a\+rX \/usr\/local\/lib\/ollama\b/.test(line),
    );
    // Calibration: an unanchored or re-worded normalization would leave this at -1 and make
    // every ordering assertion below pass vacuously against a script that never chmods.
    expect(normalizeAt).toBeGreaterThanOrEqual(0);

    const extractAt = lines.findIndex((line) =>
      /tar --use-compress-program=unzstd .*-C \/usr\/local\b/.test(line),
    );
    expect(extractAt).toBeGreaterThanOrEqual(0);
    // It must normalize what the extraction produced, not a tree that does not exist yet.
    expect(normalizeAt).toBeGreaterThan(extractAt);

    // ...and it must sit OUTSIDE the install block, or a version-matching host with a bad tree
    // never reaches it. The `fi` closing that block falls between the two.
    const closingFi = lines.findIndex(
      (line, index) => index > extractAt && line === 'fi',
    );
    expect(closingFi).toBeGreaterThan(extractAt);
    expect(normalizeAt).toBeGreaterThan(closingFi);

    // `a+rX` (capital X) is load-bearing: `a+rx` would mark every extracted data file executable.
    expect(script).not.toMatch(/chmod -R a\+rx \/usr\/local\/lib\/ollama/);
  });

  /**
   * D-264's rule, applied one service later: when a phase MUTATES a service, nothing after it may
   * assume that service's runtime state. `systemctl enable --now` returns once systemd has forked
   * the unit, not once its HTTP API accepts connections — and the pull talks to that API.
   */
  it('waits for the local-inference API to answer before pulling, and binds it to loopback', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const readyAt = script.indexOf('OLLAMA_READY=1');
    const pullAt = script.indexOf('ollama pull');
    expect(readyAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(readyAt);
    expect(script).toContain(
      '|| die "local-inference runtime did not become ready within 60s"',
    );
    // An inference endpoint on a routable address is an unauthenticated model server exposed to
    // the network. The probe reaches it over loopback and nothing else may.
    expect(script).toContain('Environment=OLLAMA_HOST=127.0.0.1:11434');
  });

  it('stages no local-inference runtime on a host that does not install OMP', () => {
    const script = buildWorkspaceHostBootstrap(
      input({
        agentRuntimeInstalls: AGENT_RUNTIME_INSTALLS.filter(
          (install) => install.agent !== 'omp',
        ).map((install) => ({ ...install, args: [...install.args] })),
      }),
    );
    // ~450 MiB of runtime plus model is not worth staging on a host with nothing to prove by it.
    expect(script).not.toContain('ollama');
  });

  /**
   * The repair must not buy npm by putting the release's `bin/` on the resolve PATH — that
   * directory holds the psu wrappers, and this is the D-247 hole the sibling test above guards.
   */
  it('obtains node without widening the resolve surface onto the release wrappers', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const pathLine = script
      .split('\n')
      .find((line) => line.startsWith('AGENT_RUNTIME_PATH='));
    // The install lands in $AGENT_HOME/.local, which the PATH ALREADY carried — so the fix adds
    // no entry at all, and the wrapper directory stays excluded.
    expect(pathLine).toContain('$AGENT_HOME/.local/bin');
    expect(pathLine).not.toContain('RELEASE_DIR');
    expect(pathLine).not.toContain('RUNTIME_ROOT');
    expect(script).toContain('target="$HOME/.local"');
  });

  it('fetches no Node when no agent runtimes are configured', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain('nodejs.org');
    expect(script).not.toContain('installing agent Node runtime');
  });

  /**
   * INSTALLED is strictly narrower than VERIFIED. The bootstrap can prove the runtime is present
   * and executable; it cannot prove it is authenticated. D-252's validator refuses the optimistic
   * lie, and that refusal must survive this feature.
   */
  it('never upgrades the installed claim into the authenticated one', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain('agentRuntimesVerifiedByBootstrap:false');
    expect(script).toContain('agentRuntimesInstalledByBootstrap:true');
    expect(script).not.toContain('agentRuntimesVerifiedByBootstrap:true');
    expect(
      validateWorkspaceHostBootstrapAttestation(
        attestation({
          runtime: {
            nodeMajor: 22,
            minimumNodeMajor: 22,
            psu: true,
            pui: true,
            agentLaunchers: { claude: true, codex: true, omp: true },
            // the lie D-252 exists to refuse, now alongside a true installed flag
            agentRuntimesVerifiedByBootstrap: true as unknown as false,
            agentRuntimesInstalledByBootstrap: true,
          },
        }),
        input(),
      ).ok,
    ).toBe(false);
  });

  it('records each resolved runtime path so the probe can exec the vendor bin, not the wrapper', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain(
      'agentRuntimes:{claude:$agentRuntimeClaude,codex:$agentRuntimeCodex,omp:$agentRuntimeOmp}',
    );
    expect(script).toContain('--arg agentRuntimeClaude "$AGENT_RUNTIME_CLAUDE"');
  });

  it('refuses a duplicate or malformed install at render time, not on a host', () => {
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          agentRuntimeInstalls: [
            { agent: 'claude', command: 'bash', args: [] },
            { agent: 'claude', command: 'bash', args: [] },
          ],
        }),
      ),
    ).toThrow(/duplicate entry for 'claude'/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          agentRuntimeInstalls: [{ agent: 'claude', command: '  ', args: [] }],
        }),
      ),
    ).toThrow(/command must be a non-empty string/);
  });
});

describe('bundle extraction storage preflight', () => {
  function probe(availableBytes: string, availableInodes = '1000000', corrupt = false) {
    const root = mkdtempSync(join(tmpdir(), 'workspace-bundle-capacity-'));
    try {
      const runtime = join(root, 'runtime');
      const release = join(runtime, 'releases', 'current-release');
      const archiveRoot = join(root, 'archive');
      mkdirSync(release, { recursive: true });
      mkdirSync(archiveRoot);
      writeFileSync(join(release, 'preserved'), 'current runtime');
      symlinkSync(release, join(runtime, 'current'));
      writeFileSync(join(archiveRoot, 'payload with spaces'), Buffer.alloc(4097));
      symlinkSync('payload with spaces', join(archiveRoot, 'link'));
      const bundle = join(root, 'bundle.tgz');
      const packed = spawnSync('tar', ['-czf', bundle, '-C', archiveRoot, '.']);
      expect(packed.status, packed.stderr?.toString()).toBe(0);
      if (corrupt) writeFileSync(bundle, 'invalid archive');
      const script = buildWorkspaceHostBootstrap(input());
      const start = script.indexOf('bundle_storage_diagnostics() {');
      const end = script.indexOf('\nbundle_storage_diagnostics\n', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'log() { printf "%s\\n" "$1"; }',
        'die() { printf "%s\\n" "$1" >&2; exit 1; }',
        'df() { printf "Filesystem Blocks Used Available Capacity Mounted\\n"; if [[ "$1" == -Pi ]]; then printf "fixture 1000000 0 %s 0%% /\\n" "$TEST_INODES"; else printf "fixture 10000000000 0 %s 0%% /\\n" "$TEST_BYTES"; fi; }',
        script.slice(start, end),
        'check_bundle_storage',
        'printf "EXTRACTION_ADMITTED\\n"',
      ].join('\n')], {
        encoding: 'utf8',
        env: { ...process.env, RUNTIME_ROOT: runtime, STATE_ROOT: join(root, 'state'), WORKSPACE_ROOT: join(root, 'workspace'), BUNDLE_PATH: bundle, TEST_BYTES: availableBytes, TEST_INODES: availableInodes },
      });
      expect(readFileSync(join(release, 'preserved'), 'utf8')).toBe('current runtime');
      return result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('rejects capacity that fits the compressed file but cannot fit block-rounded contents and reserve', () => {
    const result = probe(String(536870912 + 8192));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('insufficient release storage');
    expect(result.stdout).not.toContain('EXTRACTION_ADMITTED');
    expect(result.stdout).toContain('storage:current=');
  });

  it('admits sufficient blocks and inodes for a real archive with spaces and symlinks', () => {
    const result = probe('10000000000');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EXTRACTION_ADMITTED');
  });

  it('refuses inode exhaustion independently of free bytes', () => {
    const result = probe('10000000000', '2');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('insufficient release storage');
  });

  it('fails closed when filesystem capacity cannot be measured or the archive is invalid', () => {
    expect(probe('unavailable').stderr).toContain('cannot measure release storage capacity');
    expect(probe('10000000000', '1000000', true).stderr).toContain('cannot measure verified release archive');
  });

  it('checks verified contents before creating a stage directory', () => {
    const script = buildWorkspaceHostBootstrap(input());
    const check = script.indexOf('\n  check_bundle_storage\n');
    expect(check).toBeGreaterThan(script.indexOf('minisign -Vm'));
    expect(check).toBeLessThan(script.indexOf('STAGE_DIR="$(mktemp'));
  });

  function retention(currentKind: 'managed' | 'outside' | 'absent' = 'managed', contend = false) {
    const root = mkdtempSync(join(tmpdir(), 'workspace-bundle-retention-'));
    try {
      const runtime = join(root, 'runtime');
      const releases = join(runtime, 'releases');
      const outside = join(root, 'outside');
      mkdirSync(releases, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, 'preserved'), 'workspace data');
      const names = ['old-1', 'old-2', 'current-release', 'fallback-release', 'requested-release', 'unowned-release'];
      for (const [index, name] of names.entries()) {
        const path = join(releases, name);
        mkdirSync(path);
        writeFileSync(join(path, 'install'), 'installer', { mode: 0o755 });
        writeFileSync(join(path, 'node'), 'runtime', { mode: 0o755 });
        utimesSync(path, 1000 + index, 1000 + index);
      }
      mkdirSync(join(releases, 'unknown-data'));
      symlinkSync(outside, join(releases, 'external-link'));
      if (currentKind !== 'absent') {
        symlinkSync(currentKind === 'outside' ? outside : join(releases, 'current-release'), join(runtime, 'current'));
      }
      const script = buildWorkspaceHostBootstrap(input());
      const start = script.indexOf('bundle_storage_diagnostics() {');
      const end = script.indexOf('\nbundle_storage_diagnostics\n', start);
      const program = [
        'set -euo pipefail',
        'log() { printf "%s\\n" "$1"; }',
        'die() { printf "%s\\n" "$1" >&2; exit 1; }',
        // Ownership is the only mocked filesystem property; the suite runs without root.
        'stat() { if [[ "$1" == -c && "$2" == %u ]]; then if [[ "$3" == */unowned-release ]]; then printf "1001\\n"; else printf "0\\n"; fi; else command stat "$@"; fi; }',
        script.slice(start, end),
        'prune_bundle_releases',
      ].join('\n');
      const result = spawnSync('bash', ['-c', contend
        ? 'exec 8>"$RUNTIME_ROOT/.bootstrap.lock"; flock -n 8; (exec 8>&-; bash -c "$TEST_PROGRAM")'
        : program], {
        encoding: 'utf8',
        env: { ...process.env, RUNTIME_ROOT: runtime, RELEASE_DIR: join(releases, 'requested-release'), INSTALL_ENTRYPOINT: 'install', NODE_ENTRYPOINT: 'node', TEST_PROGRAM: program },
      });
      const present = [...names, 'unknown-data', 'external-link'].filter((name) => existsSync(join(releases, name)));
      expect(readFileSync(join(outside, 'preserved'), 'utf8')).toBe('workspace data');
      return { result, present };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reclaims old complete releases while preserving current, fallback, requested target and unknown paths', () => {
    const { result, present } = retention();
    expect(result.status, result.stderr).toBe(0);
    expect(present).toEqual(['current-release', 'fallback-release', 'requested-release', 'unowned-release', 'unknown-data', 'external-link']);
    expect(result.stdout).toContain('storage:pruning-release=');
  });

  it('does not prune without a managed current runtime or when another bootstrap owns the lock', () => {
    for (const [kind, contend] of [['outside', false], ['absent', false], ['managed', true]] as const) {
      const { result, present } = retention(kind, contend);
      expect(present).toContain('old-1');
      expect(present).toContain('old-2');
      expect(result.status).toBe(kind === 'absent' ? 0 : 1);
      expect(result.stdout).not.toContain('storage:pruning-release=');
    }
  });
});

/**
 * WI-10002837, measured 2026-09-24: ~110s after an upgrade boot every archive fetch failed once,
 * `apt-get update` only warned, and the install died on `E: Unable to locate package minisign`.
 * The same bootstrap passed minutes later after a reset. These run the RENDERED helper, so a
 * retry that stops retrying (or never gives up) fails here rather than on a live host.
 */
describe('archive access retry (WI-10002837)', () => {
  function runRetry(failuresBeforeSuccess: number, max: number) {
    const script = buildWorkspaceHostBootstrap(input());
    const helper = script.split('\n').find((line) => line.trimStart().startsWith('retry() {'));
    expect(helper).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'workspace-host-retry-'));
    try {
      return spawnSync('bash', ['-c', [
        'set -Eeuo pipefail',
        'log() { printf "%s\\n" "$1"; }',
        'sleep() { :; }',
        helper!,
        `flaky() { local n; n=$(cat "$COUNTER" 2>/dev/null || echo 0); echo $((n + 1)) > "$COUNTER"; (( n >= ${failuresBeforeSuccess} )); }`,
        `retry ${max} flaky || { printf "EXHAUSTED after %s\\n" "$(cat "$COUNTER")"; exit 3; }`,
        'printf "SUCCEEDED after %s\\n" "$(cat "$COUNTER")"',
      ].join('\n')], {
        encoding: 'utf8',
        env: { ...process.env, COUNTER: join(root, 'attempts') },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('rides out transient failures and logs each retry to stderr', () => {
    const result = runRetry(3, 10);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SUCCEEDED after 4');
    expect(result.stderr).toContain('attempt 3/10 failed');
  });

  it('gives up after its bound and returns non-zero so the caller can die', () => {
    const result = runRetry(99, 5);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('EXHAUSTED after 5');
  });

  it('makes an unreachable archive an error, and retries both apt steps', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).toMatch(/retry 10 apt_update -qq --error-on=any \|\| die "/);
    expect(script).toMatch(/retry 5 apt_install -y --no-install-recommends [^\n]* \|\| die "/);
    expect(script).not.toMatch(/^\s*apt-get update -qq\s*$/m);
    expect(script.indexOf('retry() {')).toBeLessThan(script.indexOf('retry 10 apt_update'));
  });
});

/**
 * WI-10002863, measured on avi-test 2026-09-24: one `apt-get update` ran ~30 min on a first boot
 * and apt's own timeouts never ended it, so `retry` had nothing to retry. These run the RENDERED
 * helpers against a stub apt-get, so a helper that loses its bound (or bounds dpkg) fails here.
 */
describe('wall-clock bounded archive access (WI-10002863)', () => {
  function runHelpers(body: string, env: Record<string, string> = {}) {
    const script = buildWorkspaceHostBootstrap(input());
    const helpers = script.split('\n').filter((line) => /^apt_(update|install)\(\) \{/.test(line.trimStart()));
    expect(helpers).toHaveLength(2);
    const root = mkdtempSync(join(tmpdir(), 'workspace-host-apt-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      // `update` hangs like the measured archive stall; a --download-only fetch fails on demand.
      writeFileSync(join(bin, 'apt-get'), [
        '#!/bin/sh',
        'echo "apt-get $*" >> "$LOG"',
        '[ "$1" = update ] && exec sleep 30',
        'case "$*" in *--download-only*) [ -n "${FAIL_FETCH:-}" ] && exit 100 ;; esac',
        'exit 0',
      ].join('\n'), { mode: 0o755 });
      const log = join(root, 'calls');
      const startedAt = Date.now();
      const result = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        // Record the bound the helper asked for, then enforce a 1s one so a hang is observable.
        'timeout() { echo "timeout $*" >> "$LOG"; [ "$1 $2" = "-k 30" ] || return 99; command timeout -k 1 1 "${@:4}"; }',
        ...helpers,
        body,
      ].join('\n')], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, ...env, LOG: log, PATH: `${bin}:${process.env.PATH}` },
      });
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
      return { ...result, calls, elapsedMs: Date.now() - startedAt };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('kills a hung index refresh at its bound so retry sees an ordinary failure', () => {
    const result = runHelpers('apt_update -qq --error-on=any; echo "EXIT=$?"');
    expect(result.stdout).toContain('EXIT=124');
    expect(result.elapsedMs).toBeLessThan(10_000);
    expect(result.calls[0]).toBe(`timeout -k 30 ${WORKSPACE_HOST_APT_UPDATE_TIMEOUT_SEC} apt-get update -qq --error-on=any`);
  });

  it('fetches under the bound, then installs from the cache without one', () => {
    const result = runHelpers('apt_install -y --no-install-recommends xterm; echo "EXIT=$?"');
    expect(result.stdout).toContain('EXIT=0');
    expect(result.calls).toEqual([
      `timeout -k 30 ${WORKSPACE_HOST_APT_FETCH_TIMEOUT_SEC} apt-get install --download-only -y --no-install-recommends xterm`,
      'apt-get install --download-only -y --no-install-recommends xterm',
      'apt-get install -y --no-install-recommends xterm',
    ]);
  });

  it('never reaches dpkg when the bounded fetch fails', () => {
    const result = runHelpers('apt_install -y xterm; echo "EXIT=$?"', { FAIL_FETCH: '1' });
    expect(result.stdout).toContain('EXIT=100');
    expect(result.calls.filter((call) => call.startsWith('apt-get install -y'))).toEqual([]);
  });

  it('routes every networked apt call through a bounded helper and stall-guards every download', () => {
    const script = buildWorkspaceHostBootstrap(input());
    const unbounded = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /\bapt-get (update|install)\b/.test(line) && !/^\s*apt_(update|install)\(\) \{/.test(line));
    expect(unbounded).toEqual([]);
    expect(script.indexOf('apt_update() {')).toBeLessThan(script.indexOf('retry 10 apt_update'));
    // The release bundle and its signature; agent-runtime downloads render only when opted in.
    const downloads = script.split('\n').filter((line) => /\bcurl\b/.test(line) && /(\s-o\s|--output\s)/.test(line));
    expect(downloads.length).toBeGreaterThanOrEqual(2);
    for (const line of downloads) expect(line).toContain(WORKSPACE_HOST_CURL_STALL_GUARD);
  });
});

describe('buildWorkspaceHostBootstrap', () => {
  it('emits one deterministic, ordered, signed and loopback-only host contract', () => {
    const first = buildWorkspaceHostBootstrap(input());
    const replay = buildWorkspaceHostBootstrap(input());
    expect(first).toBe(replay);
    const syntax = spawnSync('bash', ['-n'], {
      input: first,
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);

    let previous = -1;
    for (const phase of WORKSPACE_HOST_BOOTSTRAP_PHASES) {
      const position = first.indexOf(`phase '${phase}'`);
      expect(position, phase).toBeGreaterThan(previous);
      previous = position;
    }

    expect(first).toContain('Ubuntu 24.04 is required');
    expect(first).toContain('PasswordAuthentication no');
    expect(first).toContain('PermitRootLogin no');
    expect(first).toContain('minisign -Vm');
    expect(first).toContain('sha256sum --check --strict');
    expect(first).toContain("SERVICE_USER='papercusp'");
    expect(first).toContain("WORKSPACE_USER='papercusp-workspace'");
    expect(first).toContain(
      'usermod --lock --gid "$WORKSPACE_GROUP" --groups ""',
    );
    expect(first).toContain(
      'setfacl -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx',
    );
    expect(first).toContain('AuthenticationMethods publickey');
    expect(first).toContain('AllowUsers $WORKSPACE_USER');
    expect(first).toContain('AllowTcpForwarding local');
    expect(first).toContain('PermitOpen 127.0.0.1:$SERVICE_PORT');
    expect(first).toContain(
      'PAPERCUSP_EMBEDDED_PG_ROOT=$STATE_ROOT/embedded-pg',
    );
    expect(first).toContain('PAPERCUSP_WORKSPACE_ROOT=$WORKSPACE_ROOT');
    expect(first).toContain('bin/papercusp-migrate');
    expect(first).toContain('bin/psu');
    expect(first).toContain("PUI_ENTRYPOINT='bin/pui'");
    expect(first).toContain("PUI_COMPANION_PATH='pui-companion.wasm'");
    expect(first).toContain("PUI_INSTALL_MANIFEST_PATH='pui-install.json'");
    expect(first).toContain('missing or empty PUI companion');
    expect(first).toContain('missing or empty PUI install manifest');
    expect(first).toContain('bin/claude');
    expect(first).toContain('bin/codex');
    expect(first).toContain('bin/omp');
    expect(first).toContain('Environment=PAPERCUSP_BIND_HOST=127.0.0.1');
    expect(first).toContain(
      `REMOTE_INITIALIZER_CONDUIT='${WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT}'`,
    );
    expect(first).toContain(
      `CREDENTIAL_DELIVERY_CONDUIT='${WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT}'`,
    );
    expect(first).toContain(
      `PRIVILEGED_CONDUIT_SUDOERS='${WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS}'`,
    );
    expect(first).toContain("initializer conduit: refused argv");
    expect(first).toContain("credential delivery conduit: refused argv");
    expect(first).toContain("Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_INITIALIZER");
    expect(first).toContain("Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_DELIVERY");
    expect(first).toContain('visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS"');
    expect(first).toContain(
      'Environment=PUI_COMPANION_WASM=$RUNTIME_ROOT/current/$PUI_COMPANION_PATH',
    );
    expect(first).toContain(
      'Environment=PUI_INSTALL_MANIFEST=$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH',
    );
    expect(first).toContain(
      'PUI_OPERATOR="http://127.0.0.1:$SERVICE_PORT" PUI_COMPANION_WASM=',
    );
    expect(first).toContain('"$RUNTIME_ROOT/current/$PUI_ENTRYPOINT" doctor');
    expect(first).toContain('ReadOnlyPaths=$RUNTIME_ROOT');
    expect(first).toContain('ReadWritePaths=$STATE_ROOT $WORKSPACE_ROOT');
    expect(first).toContain('chown -R "root:$SERVICE_GROUP" "$RELEASE_DIR"');
    expect(first).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r');
    expect(first).toContain('StandardOutput=journal');
    expect(first).toContain(WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX);
    expect(first).toContain(
      `apt_install -y --no-install-recommends ${WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES.join(' ')}`,
    );
    expect(first).not.toContain('RWQpublickey');
    expect(first).not.toMatch(/PAPERCUSP_(?:API_KEY|TOKEN|PASSWORD)=/);
    expect(first).not.toContain('AllowTcpForwarding yes');
    expect(first).not.toMatch(/usermod .*sudo/);
  });

  it('repairs only historical non-root ownership when persisted homes cross an image UID/GID boundary', () => {
    const script = buildWorkspaceHostBootstrap(input());

    expect(script).toContain('repair_persisted_home_ownership() {');
    expect(script).toContain('chown -R -h --from="$current_uid" "$expected_uid" -- "$target_home"');
    expect(script).toContain('chown -R -h --from=":$current_gid" ":$expected_gid" -- "$target_home"');
    expect(script).toContain('die "persisted home has unexpected root owner: $target_home"');
    expect(script).toContain('die "persisted home has unexpected root group: $target_home"');
    expect(script).toContain(
      'repair_persisted_home_ownership "$WORKSPACE_USER" "$WORKSPACE_GROUP" "/home/$WORKSPACE_USER"',
    );
    expect(script).toContain(
      'repair_persisted_home_ownership "$AGENT_USER" "$AGENT_GROUP" "$AGENT_HOME"',
    );

    expect(script.indexOf('useradd --gid "$WORKSPACE_GROUP"')).toBeLessThan(
      script.indexOf('repair_persisted_home_ownership "$WORKSPACE_USER"'),
    );
    expect(script.indexOf('repair_persisted_home_ownership "$WORKSPACE_USER"')).toBeLessThan(
      script.indexOf('install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700'),
    );
    expect(script.indexOf('useradd --system --gid "$AGENT_GROUP"')).toBeLessThan(
      script.indexOf('repair_persisted_home_ownership "$AGENT_USER"'),
    );
    expect(script.indexOf('repair_persisted_home_ownership "$AGENT_USER"')).toBeLessThan(
      script.indexOf('install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700'),
    );
  });

  it('executes ownership repair only after validating both IDs and rejects linked homes', () => {
    const script = buildWorkspaceHostBootstrap(input());
    const start = script.indexOf('repair_persisted_home_ownership() {');
    const end = script.indexOf('\n}', start) + 2;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const root = mkdtempSync(join(tmpdir(), 'persisted-home-owner-'));
    const homePath = join(root, 'customer');
    mkdirSync(homePath);
    const run = (uid: string, gid: string, path = homePath) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'die() { echo "$*" >&2; exit 1; }',
      'id() { echo 1002; }',
      'getent() { echo customer:x:1003:; }',
      'stat() { if [[ "$2" == "%u" ]]; then echo "$OLD_UID"; else echo "$OLD_GID"; fi; }',
      'chown() { printf "chown"; printf " <%s>" "$@"; printf "\\n"; }',
      script.slice(start, end),
      'repair_persisted_home_ownership customer customer "$TEST_HOME"',
    ].join('\n')], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, OLD_UID: uid, OLD_GID: gid, TEST_HOME: path },
    });
    try {
      const changed = run('1000', '1001');
      expect(changed.status, changed.stderr).toBe(0);
      expect(changed.stdout.trim().split('\n')).toEqual([
        `chown <-R> <-h> <--from=1000> <1002> <--> <${homePath}>`,
        `chown <-R> <-h> <--from=:1001> <:1003> <--> <${homePath}>`,
      ]);
      const unchanged = run('1002', '1003');
      expect(unchanged.status, unchanged.stderr).toBe(0);
      expect(unchanged.stdout).toBe('');
      for (const [uid, gid] of [['0', '1001'], ['1000', '0']]) {
        const refused = run(uid!, gid!);
        expect(refused.status).toBe(1);
        expect(refused.stdout).toBe('');
      }
      const linkedHome = join(root, 'link');
      symlinkSync(homePath, linkedHome);
      expect(run('1000', '1001', linkedHome).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The unit's WorkingDirectory is the STATE root, because that is the only writable place the
   * service owns. Every content resolver in the server falls back to probing relative to cwd,
   * so each content root must be pinned to the RELEASE root explicitly or it resolves under the
   * state root, where none of them exists.
   *
   * Measured (P-046, 2026-08-29): with these absent the server died at boot with
   *   prompt-assembly: oracle.persona.md not found at
   *   /var/lib/papercusp/apps/operator/prompts/oracle.persona.md
   * `promptsDir()` had tried cwd/apps/operator/prompts, cwd/prompts, and a module walk-up for
   * apps/operator/prompts — the bundle ships prompts/ at its own root, so all three missed.
   *
   * Prompts is only the first of these to THROW; a missing SPA or docs root starts a server
   * that quietly serves nothing, which is why all five are pinned rather than just the one
   * that failed loudly.
   */
  it('runs the agents as a THIRD identity, so the runtime is readable by whoever executes it and never by the SSH login (D-043, D-246, D-248)', () => {
    const script = buildWorkspaceHostBootstrap(input());

    // The defect D-246 measured: the account that receives Claude/Codex/OMP credentials could not
    // traverse /opt/papercusp, so all three probes died with `env: 'claude': Permission denied`
    // (exit 126) six steps into a live canary. The grant is a named-user ACL on the runtime root
    // AND across the extracted release — the agent CLIs are wrappers that re-exec the bundled
    // node and read scripts/psu.mjs, so the entrypoints alone are not enough.
    //
    // The identity D-248 corrects: it is $AGENT_USER, not $WORKSPACE_USER. Both halves are
    // asserted here BECAUSE EITHER ONE ALONE IS SATISFIABLE BY A BROKEN HOST — a host with only
    // the grant is D-246's violation of the D-043 owner ruling, and a host with only the ban has
    // no runnable agents. That is exactly how the first fix passed every test it ran.
    expect(script).toContain(
      'setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"',
    );
    expect(script).toContain('setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"');
    expect(script).not.toContain('setfacl -m "u:$WORKSPACE_USER:r-x" "$RUNTIME_ROOT"');
    expect(script).not.toContain('setfacl -R -m "u:$WORKSPACE_USER:rX" "$RELEASE_DIR"');

    // Ordering guard. NOT because the current sequence would otherwise break: measured over this
    // exact chmod set, the resulting mask is `r-x` either way, since `g-w`/`g+rx`/`g+r` are all
    // additive. It is pinned because chmod's group bits address the ACL MASK once an ACL exists,
    // so changing any of them to an assigning form (`chmod g=r`) with the ACL applied first would
    // clamp execute away — a failure invisible until an agent CLI refuses to run on a real host.
    expect(script.indexOf('find "$RELEASE_DIR" -type f -exec chmod g+r {} +')).toBeLessThan(
      script.indexOf('setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"'),
    );

    // The recurrence guard for D-246: prove executability at bootstrap time, which is where this
    // should have failed instead of inside a live canary — now as the agent identity.
    expect(script).toContain(
      '  runuser -u "$AGENT_USER" -- test -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "agent identity cannot execute agent entrypoint: $agent_entrypoint"',
    );

    // The recurrence guard for D-248: the assertion D-246 deleted is back. This is the mechanical
    // enforcement of the D-043 sentence, and deleting it is how a widened grant ships unnoticed.
    expect(script).toContain(
      'runuser -u "$WORKSPACE_USER" -- test ! -r "$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT" || die "workspace SSH user can read the Papercusp runtime"',
    );
    expect(script).toContain(
      '  runuser -u "$WORKSPACE_USER" -- test ! -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "workspace SSH user can execute agent entrypoint: $agent_entrypoint"',
    );

    // The credential half. On a BYOC host the SSH account is the CUSTOMER's access path, and
    // before D-248 it OWNED the delivered agent credentials at 0600 in its own home.
    expect(script).toContain(
      'install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"',
    );
    expect(script).toContain(
      'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "workspace SSH user can read the agent credential home"',
    );

    // The agent identity is confined in every direction the SSH account is, and is non-login.
    expect(script).toContain('die "agent identity can write the Papercusp runtime"');
    expect(script).toContain('die "agent identity can read the runtime state root"');
    expect(script).toContain('die "agent identity belongs to the runtime service group"');
    expect(script).toContain('die "agent identity belongs to sudo"');
    expect(script).toContain('die "agent identity has a login shell"');
    expect(script).toContain(
      'usermod --lock --gid "$AGENT_GROUP" --groups "" --home "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"',
    );

    // Confinement of the SSH account is unchanged.
    expect(script).toContain('die "workspace SSH user can write the Papercusp runtime"');
    expect(script).toContain('die "workspace SSH user can read the runtime state root"');
    expect(script).toContain('die "runtime release tree must not be world-readable"');
    expect(script).toContain(
      'die "workspace SSH user belongs to the runtime service group"',
    );
    expect(script).toContain('die "workspace SSH user belongs to the agent group"');
    expect(script).toContain('die "workspace SSH user belongs to sudo"');
    expect(script).toContain('usermod --lock --gid "$WORKSPACE_GROUP" --groups ""');

    // All three identities write the scoped workspace root — otherwise the customer cannot edit
    // over SSH what the agent wrote, which is the product.
    expect(script).toContain(
      'setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    );
    expect(script).toContain('die "agent identity cannot write the scoped workspace root"');
    expect(script).toContain('die "workspace SSH user cannot write the scoped workspace root"');
  });

  it('attests agent LAUNCHERS, never agent RUNTIMES, and refuses the optimistic claim (D-252)', () => {
    const script = buildWorkspaceHostBootstrap(input());

    // What bootstrap can prove is `test -x` on three 539-byte psu launcher wrappers. It ships no
    // vendor CLI and nothing installs one, so the old flat `claude:true,codex:true,omp:true` —
    // read by every caller as "this host can run Claude" — was measuring a file permission while
    // naming a product property. Same defect class as the pre-D-251 read boolean.
    expect(script).toContain(
      'agentLaunchers:{claude:true,codex:true,omp:true},agentRuntimesVerifiedByBootstrap:false',
    );
    expect(script).not.toContain('pui:true,claude:true,codex:true,omp:true');

    // The validator must refuse the OPTIMISTIC direction specifically. A host asserting that
    // bootstrap verified its agent runtimes is running pre-D-252 code or was hand-edited; either
    // way nothing could have established the claim, since bootstrap has no such probe.
    const overclaiming = validateWorkspaceHostBootstrapAttestation(
      attestation({
        runtime: {
          ...attestation().runtime,
          agentRuntimesVerifiedByBootstrap: true as false,
        },
      }),
      input(),
    );
    expect(overclaiming.ok).toBe(false);
    expect(overclaiming.errors).toContain(
      'attestation claims bootstrap verified the agent runtimes; bootstrap cannot establish that (D-252)',
    );

    // A missing launcher is still a refusal — narrowing the CLAIM must not weaken the CHECK.
    const missingLauncher = validateWorkspaceHostBootstrapAttestation(
      attestation({
        runtime: {
          ...attestation().runtime,
          agentLaunchers: { ...attestation().runtime.agentLaunchers, codex: false as true },
        },
      }),
      input(),
    );
    expect(missingLauncher.ok).toBe(false);
    expect(missingLauncher.errors).toContain('agent launcher prerequisite check failed');

    expect(validateWorkspaceHostBootstrapAttestation(attestation(), input()).ok).toBe(true);
  });

  it('refuses to collapse the agent identity onto either existing account (D-248)', () => {
    // Each collapse is individually plausible and individually catastrophic: onto the SSH login
    // it re-grants the customer runtime read (D-043) and hands them the platform's agent
    // credentials; onto the service account it gives the agent runtime $STATE_ROOT, which holds
    // embedded PG and every delivered credential. Neither is caught downstream — every later
    // check passes on both shapes — so the refusal has to be here.
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { agentUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER } }),
      ),
    ).toThrow(/agent identity must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { agentUser: DEFAULT_WORKSPACE_HOST_SERVICE_USER } }),
      ),
    ).toThrow(/agent identity must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          isolation: {
            agentUser: 'pc-agent',
            agentGroup: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
          },
        }),
      ),
    ).toThrow(/agent group must differ/);
  });

  it('attests the runtime as agent-readable and NEVER workspace-readable (D-043, D-248)', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).toContain(
      'runtimeReadableByWorkspaceUser:false,runtimeWritableByWorkspaceUser:false,runtimeReadableByAgentUser:true,runtimeWritableByAgentUser:false,agentHomeReadableBySshUser:false',
    );

    // Three separate refusals, because the three failure shapes are different hosts. The
    // validator is what a caller who never saw the host runs, so each has to be legible there.
    const readable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeReadableByWorkspaceUser: true as false,
        },
      }),
      input(),
    );
    expect(readable.ok).toBe(false);
    expect(readable.errors).toContain(
      'workspace SSH user can read the Papercusp runtime (D-043)',
    );

    const unrunnable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeReadableByAgentUser: false as true,
        },
      }),
      input(),
    );
    expect(unrunnable.ok).toBe(false);
    expect(unrunnable.errors).toContain(
      'agent identity cannot read the runtime it must execute agents from',
    );

    const exposed = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          agentHomeReadableBySshUser: true as false,
        },
      }),
      input(),
    );
    expect(exposed.ok).toBe(false);
    expect(exposed.errors).toContain(
      'workspace SSH user can read the delivered agent credential home',
    );

    const writable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeWritableByAgentUser: true as false,
        },
      }),
      input(),
    );
    expect(writable.ok).toBe(false);
    expect(writable.errors).toContain('an unprivileged identity can write the runtime');

    // A correctly-attesting host must not trip any of them.
    expect(
      validateWorkspaceHostBootstrapAttestation(attestation(), input()).errors,
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /read the Papercusp runtime|must execute agents from|credential home|can write the runtime/,
        ),
      ]),
    );
  });

  it('pins Cupboard content to persistent state while static UI/docs remain release-scoped', () => {
    const unit = buildWorkspaceHostBootstrap(input());

    expect(unit).toContain('Environment=PAPERCUSP_HOME=$STATE_ROOT/.papercusp');
    // WI-10003189: blueprint prompt resolution (su persona for New Session) must read the
    // installed content home, never the release — the release carries no blueprints.
    expect(unit).toContain('Environment=PAPERCUSP_PROMPT_ROOT=$STATE_ROOT/.papercusp\n');
    expect(unit).not.toContain('Environment=PAPERCUSP_PROMPT_ROOT=$RUNTIME_ROOT');
    // WI-10003189: long-lived sessions target the host's own operator, never the dev
    // box's :9071 MCP proxy (a host runs none).
    expect(unit).toContain('Environment=PAPERCUSP_MCP_PROXY_BASE=http://127.0.0.1:$SERVICE_PORT\n');
    expect(unit).not.toContain('9071');
    for (const [envVar, dir] of [
      ['PAPERCUSP_PROMPTS_DIR', 'blueprints/base/prompts'],
      ['PAPERCUSP_TEMPLATES_DIR', 'templates'],
      ['PAPERCUSP_RUBRICS_DIR', 'rubrics'],
    ] as const) {
      expect(unit).toContain(`Environment=${envVar}=$STATE_ROOT/.papercusp/${dir}`);
      expect(unit).not.toContain(`Environment=${envVar}=$RUNTIME_ROOT/current`);
    }
    for (const [envVar, dir] of [
      ['PAPERCUSP_SPA_DIST', 'spa'],
      ['PAPERCUSP_DOCS_ROOT', 'internal-docs'],
      // WI-10004899: the cut packs the doc-vector seed beside the docs it covers.
      ['PAPERCUSP_DOC_VECTOR_SEED_DIR', 'doc-vector-seed'],
    ] as const) {
      expect(unit).toContain(`Environment=${envVar}=$RUNTIME_ROOT/current/${dir}`);
    }
    expect(unit).toContain(
      'runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" "$RELEASE_DIR/$INSTALL_ENTRYPOINT"',
    );
  });

  it('defines replay-safe install, upgrade, rollback, and failure restoration', () => {
    const upgrade = buildWorkspaceHostBootstrap(input({ action: 'upgrade' }));
    const rollback = buildWorkspaceHostBootstrap(input({ action: 'rollback' }));
    expect(upgrade).toContain("BOOTSTRAP_ACTION='upgrade'");
    expect(upgrade).toContain(
      'PREVIOUS_TARGET="$(readlink -f "$RUNTIME_ROOT/current"',
    );
    expect(upgrade).toContain('restore_previous()');
    expect(upgrade).toContain(
      'ln -sfn "$RELEASE_DIR" "$RUNTIME_ROOT/current.next"',
    );
    expect(rollback).toContain("BOOTSTRAP_ACTION='rollback'");
    expect(rollback).toContain('"$RELEASE_DIR/$ROLLBACK_ENTRYPOINT"');
  });

  /**
   * Live P-018 r7 repair, 2026-09-06. The refreshed r25 bootstrap installed and selected r25,
   * but the r24 service was already active in its restart loop. `systemctl enable --now` returned
   * without restarting that process, so attest-health observed r24 failing its old migration 389
   * and the bootstrap correctly rolled the symlink back. Starting an inactive unit is not enough:
   * every release switch must exec the newly selected release even when an old unit is active.
   */
  it('restarts the workspace service after the release switch even when an old unit is active', () => {
    // Lifecycle `repair` deliberately renders the release bootstrap's supported `upgrade` action.
    const repair = buildWorkspaceHostBootstrap(input({ action: 'upgrade' }));
    const lines = repair.split('\n');
    const switchAt = lines.indexOf('mv -Tf "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"');
    const reloadAt = lines.indexOf('systemctl daemon-reload');
    const enableAt = lines.indexOf('systemctl enable "$SERVICE_NAME.service" || { service_diagnostics; die "workspace service failed to enable"; }');
    const restartAt = lines.indexOf('  if systemctl restart "$SERVICE_NAME.service"; then');

    // Calibration: no missing command may pass the ordering assertions through a -1 index.
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(switchAt);
    expect(enableAt).toBeGreaterThan(reloadAt);
    expect(restartAt).toBeGreaterThan(enableAt);
    // WI-10006110: the restart runs under the in-flight start sampler, and a failed start
    // carries both the post-mortem and the in-flight diagnostics before dying.
    expect(lines.slice(restartAt - 3, restartAt)).toEqual([
      'if service_restart_needed; then',
      '  start_sampler',
      '  SERVICE_START_T0=$SECONDS',
    ]);
    const elseAt = lines.indexOf('  else', restartAt);
    expect(lines.slice(elseAt + 1, elseAt + 5)).toEqual([
      '    stop_sampler',
      '    service_diagnostics',
      '    start_diagnostics',
      '    die "workspace service failed to start"',
    ]);
    expect(repair).not.toContain('systemctl enable --now "$SERVICE_NAME.service"');
  });

  /**
   * WI-10006110 / chain10: once the bootc service started, attest-health died on 'runtime release
   * tree must not be world-readable'. The bootc image keeps executables a+rx on purpose
   * (embedded-postgres checks all 0555 bits) and carries confidentiality on its 0750 parents, so
   * the ubuntu predicate can never pass there. The bootc render must assert that contract
   * instead, and still refuse every other world-readable shape.
   */
  it('keeps the bootc agent identity in exactly the runtime-read group the image declares (WI-10006173)', () => {
    // The image is the source of truth: sysusers.conf makes the agent a member of the group that
    // owns the 0750 /opt/papercusp parents, and host-prepare re-verifies it every boot. Clearing
    // the agent's supplementary groups (the ubuntu shape) left bin/claude unexecutable on bootc.
    const sysusers = readFileSync(
      new URL('../../../../infra/images/bootc/papercusp-sysusers.conf', import.meta.url),
      'utf8',
    );
    const declared = sysusers
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f[0] === 'm' && f[1] === DEFAULT_WORKSPACE_HOST_AGENT_USER)
      .map((f) => f[2]);
    expect(declared).toEqual([WORKSPACE_HOST_BOOTC_RUNTIME_READ_GROUP]);

    const agentUsermod = (script: string) =>
      script.split('\n').filter((l) => /^usermod\b/.test(l) && l.endsWith('"$AGENT_USER"'));
    const bootc = agentUsermod(buildWorkspaceHostBootstrap(bootcInput()));
    const ubuntu = agentUsermod(buildWorkspaceHostBootstrap(input()));
    expect(bootc).toHaveLength(1);
    expect(ubuntu).toHaveLength(1);
    expect(ubuntu[0]).toContain('--groups ""');
    expect(bootc[0]).not.toContain('--groups ""');

    // Run the rendered line against a recording usermod: the argv must carry the declared group
    // as the value of --groups, so the shell quoting cannot silently drop it.
    const dir = mkdtempSync(join(tmpdir(), 'wh-agent-groups-'));
    try {
      const log = join(dir, 'argv');
      writeFileSync(join(dir, 'usermod'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`);
      chmodSync(join(dir, 'usermod'), 0o755);
      const script = [
        `PATH=${JSON.stringify(dir)}:$PATH`,
        'AGENT_GROUP=papercusp-agent AGENT_HOME=/home/papercusp-agent AGENT_USER=papercusp-agent',
        bootc[0],
      ].join('\n');
      const run = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
      expect(run.status).toBe(0);
      const argv = readFileSync(log, 'utf8').trim().split('\n');
      expect(argv[argv.indexOf('--groups') + 1]).toBe(declared.join(','));
      expect(argv.at(-1)).toBe('papercusp-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WI-10006258: the first bootc host to reach the hosted-PTY loopback was refused
  // `Permission denied (publickey)` and the die path carried no evidence of why.
  const shellFunction = (script: string, name: string): string => {
    const lines = script.split('\n');
    const start = lines.findIndex((l) => l === `${name}() {`);
    expect(start, `${name}() is rendered`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const withStubs = (stubs: Record<string, string>, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-stubs-'));
    try {
      for (const [name, sh] of Object.entries(stubs)) {
        writeFileSync(join(dir, name), `#!/bin/sh\n${sh}\n`);
        chmodSync(join(dir, name), 0o755);
      }
      return spawnSync('bash', ['-c', `set -euo pipefail\nPATH=${JSON.stringify(dir)}:$PATH\n${body}`], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('dumps the boot AVC denials on every die on an SELinux host, and stays silent without SELinux (WI-10006258)', () => {
    const script = buildWorkspaceHostBootstrap(bootcInput());
    const die = script.split('\n').find((l) => l.startsWith('die() {'));
    expect(die).toContain('selinux_denials >&2');
    const prelude = [
      'log() { printf "[workspace-host-bootstrap] %s\\n" "$1"; }',
      shellFunction(script, 'selinux_denials'),
      die,
      'die "hosted customer PTY loopback authentication or isolation failed"',
    ].join('\n');
    const avc = 'type=AVC msg=audit(1): avc:  denied  { read } for comm="sshd-session" name="authorized_keys" tcontext=system_u:object_r:user_home_dir_t:s0';
    const enforcing = withStubs(
      { selinuxenabled: 'exit 0', journalctl: `printf '%s\\n' 'noise' '${avc}'` },
      prelude,
    );
    expect(enforcing.status).toBe(1);
    expect(enforcing.stderr).toContain('ERROR: hosted customer PTY loopback authentication or isolation failed');
    expect(enforcing.stderr).toContain('--- SELinux denials this boot ---');
    expect(enforcing.stderr).toContain('name="authorized_keys"');
    expect(enforcing.stderr).not.toContain('noise');

    const ubuntu = withStubs({ selinuxenabled: 'exit 1', journalctl: `printf '%s\\n' '${avc}'` }, prelude);
    expect(ubuntu.status).toBe(1);
    expect(ubuntu.stderr).not.toContain('SELinux denials');
  });

  it('relabels the workspace .ssh to the policy default on SELinux hosts, logging both labels (WI-10006258)', () => {
    const lines = buildWorkspaceHostBootstrap(bootcInput()).split('\n');
    const write = lines.findIndex((l) => l.includes('base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"'));
    const ptyKey = lines.findIndex((l) => l.includes('>> "/home/$WORKSPACE_USER/.ssh/authorized_keys"'));
    // The hosted PTY key directory has its own SELinux block earlier in harden-os (WI-10006903),
    // so find the guard that follows the ~/.ssh writes rather than the first one in the script.
    const guard = lines.findIndex(
      (l, i) => i > ptyKey && l === 'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then',
    );
    const restore = lines.findIndex((l) => l.includes('restorecon -RF "/home/$WORKSPACE_USER/.ssh"'));
    const dropIn = lines.findIndex((l) => l.startsWith('cat > /etc/ssh/sshd_config.d/'));
    // After every write into ~/.ssh, before sshd is reconfigured.
    expect(write).toBeGreaterThan(0);
    expect(ptyKey).toBeGreaterThan(write);
    expect(guard).toBeGreaterThan(ptyKey);
    expect(restore).toBe(guard + 2);
    expect(dropIn).toBeGreaterThan(restore);

    const block = lines.slice(guard, guard + 5).join('\n');
    expect(block.split('\n')[4]).toBe('fi');
    const log = 'log() { printf "[workspace-host-bootstrap] %s\\n" "$1"; }\ndie() { echo "DIE $1" >&2; exit 1; }';
    const recorded = withStubs(
      {
        selinuxenabled: 'exit 0',
        restorecon: 'echo "restorecon $*"',
        stat: 'for p in "$@"; do case "$p" in -*|%*) ;; *) echo "$p=ctx" ;; esac; done',
      },
      `WORKSPACE_USER=papercusp-workspace\n${log}\n${block}`,
    );
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain('selinux labels before restorecon: /home/papercusp-workspace=ctx');
    expect(recorded.stdout).toContain('restorecon -RF /home/papercusp-workspace/.ssh');
    expect(recorded.stdout).toContain('selinux labels after restorecon:');

    const skipped = withStubs(
      { selinuxenabled: 'exit 1', restorecon: 'echo "restorecon $*"' },
      `WORKSPACE_USER=papercusp-workspace\n${log}\n${block}`,
    );
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).not.toContain('restorecon');
  });

  // WI-10006903: on a bootc host ssh-keygen, started from the bootstrap's initrc_t domain, enters
  // the confined ssh_keygen_t. Measured on a P-012 AWS host in that exact domain: it was refused
  // writing the key into a var_lib_t directory (the policy default for this path) and accepted an
  // ssh_home_t one, so the directory must be registered as an SSH identity directory.
  it('labels the hosted PTY key directory ssh_home_t before ssh-keygen on SELinux hosts (WI-10006903)', () => {
    const lines = buildWorkspaceHostBootstrap(bootcInput()).split('\n');
    const dir = lines.findIndex((l) => l.includes('-m 0700 "$(dirname "$HOSTED_PTY_SSH_KEY")"'));
    const guard = lines.findIndex(
      (l, i) => i > dir && l === 'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then',
    );
    const end = lines.findIndex((l, i) => i > guard && l === 'fi');
    const keygen = lines.findIndex((l) => l.includes('ssh-keygen -q -t ed25519') && l.includes('"$HOSTED_PTY_SSH_KEY"'));
    // Directly after the directory exists, directly before the key is generated into it.
    expect(dir).toBeGreaterThan(0);
    expect(guard).toBe(dir + 1);
    expect(keygen).toBe(end + 1);

    const block = lines.slice(guard, end + 1).join('\n');
    const prelude = [
      `STATE_ROOT='${WORKSPACE_HOST_STATE_ROOT}'`,
      `HOSTED_PTY_SSH_KEY='${WORKSPACE_HOST_HOSTED_PTY_SSH_KEY}'`,
      'die() { echo "DIE $1" >&2; exit 1; }',
    ].join('\n');
    const keyDir = WORKSPACE_HOST_HOSTED_PTY_SSH_KEY.replace(/\/[^/]+$/, '');
    const run = (stubs: Record<string, string>) =>
      withStubs({ selinuxenabled: 'exit 0', restorecon: 'echo "restorecon $*"', semanage: 'echo "semanage $*"', ...stubs }, `${prelude}\n${block}`);

    // A fresh host: the policy still maps the directory to var_lib_t, so the rule is registered.
    const fresh = run({
      matchpathcon: 'echo "system_u:object_r:var_lib_t:s0"',
      stat: 'echo "system_u:object_r:ssh_home_t:s0"',
    });
    expect(fresh.status, fresh.stderr).toBe(0);
    const calls = fresh.stdout.trim().split('\n');
    expect(calls).toEqual([
      `restorecon -F ${WORKSPACE_HOST_STATE_ROOT}`,
      `semanage fcontext -a -t ssh_home_t ${keyDir}(/.*)?`,
      `restorecon -RF ${keyDir}`,
    ]);

    // A re-run: the rule already exists, so it is not re-added (semanage -a would refuse it).
    const rerun = run({
      matchpathcon: 'echo "system_u:object_r:ssh_home_t:s0"',
      stat: 'echo "system_u:object_r:ssh_home_t:s0"',
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).not.toContain('semanage');
    expect(rerun.stdout).toContain(`restorecon -RF ${keyDir}`);

    // The relabel did not take: fail here, naming the label, not later at ssh-keygen's bare EACCES.
    const stuck = run({
      matchpathcon: 'echo "system_u:object_r:var_lib_t:s0"',
      stat: 'echo "system_u:object_r:var_lib_t:s0"',
    });
    expect(stuck.status).not.toBe(0);
    expect(stuck.stderr).toContain('DIE hosted PTY key directory is not labeled ssh_home_t: system_u:object_r:var_lib_t:s0');

    // No SELinux (Ubuntu): nothing is relabeled.
    const ubuntu = run({ selinuxenabled: 'exit 1' });
    expect(ubuntu.status, ubuntu.stderr).toBe(0);
    expect(ubuntu.stdout).toBe('');
  });

  it('a refused hosted-PTY loopback prints its sshd evidence before dying (WI-10006258)', () => {
    const script = buildWorkspaceHostBootstrap(bootcInput());
    const loopback = script.split('\n').find((l) => l.includes('-l "$WORKSPACE_USER" 127.0.0.1'));
    expect(loopback).toMatch(
      /\|\| \{ pty_loopback_evidence >&2; die "hosted customer PTY loopback authentication or isolation failed"; \}$/,
    );
    const run = withStubs(
      {
        sshd: `printf '%s\\n' 'usepam yes' 'strictmodes yes' 'authorizedkeysfile .ssh/authorized_keys' 'port 22'`,
        journalctl: `echo 'Authentication refused: bad ownership or modes for directory /var/home/papercusp-workspace'`,
        getent: 'echo "papercusp-workspace:x:1001:1001::/home/papercusp-workspace:/bin/bash"',
        passwd: 'echo "papercusp-workspace LK"',
        stat: 'echo "stat $*"',
      },
      `WORKSPACE_USER=papercusp-workspace\n${shellFunction(script, 'pty_loopback_evidence')}\npty_loopback_evidence`,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--- hosted PTY loopback evidence ---');
    expect(run.stdout).toContain('strictmodes yes');
    expect(run.stdout).not.toContain('port 22');
    expect(run.stdout).toContain('Authentication refused: bad ownership');
    expect(run.stdout).toContain('%C');
  });

  it('writes the sshd drop-in as 05- so vendor 50- drop-ins cannot override it, and attests X11 off (WI-10006176)', () => {
    for (const script of [buildWorkspaceHostBootstrap(bootcInput()), buildWorkspaceHostBootstrap(input())]) {
      const lines = script.split('\n');
      // sshd keeps the FIRST value per keyword; CentOS 50-redhat.conf sets X11Forwarding yes.
      const legacy = lines.indexOf('rm -f /etc/ssh/sshd_config.d/60-papercusp-workspace.conf');
      const dropIn = lines.indexOf('cat > /etc/ssh/sshd_config.d/05-papercusp-workspace.conf <<PAPERCUSP_SSH');
      expect(legacy).toBeGreaterThan(0);
      expect(dropIn).toBe(legacy + 1);
      expect(lines.slice(dropIn, lines.indexOf('PAPERCUSP_SSH', dropIn))).toContain('X11Forwarding no');
      expect(script).not.toMatch(/cat > \/etc\/ssh\/sshd_config\.d\/60-/);
      expect(lines).toContain(
        'grep -Fx "x11forwarding no" <<<"$SSHD_POLICY" >/dev/null || die "SSH X11 forwarding must be off; a vendor sshd drop-in is overriding the workspace policy"',
      );
    }
  });

  it('writes the completion marker to a root-only /var/lib dir, never the read-only bootc runtime root (WI-10006299)', () => {
    for (const script of [buildWorkspaceHostBootstrap(bootcInput()), buildWorkspaceHostBootstrap(input())]) {
      const lines = script.split('\n');
      const dirAssignment = lines.find((l) => l.startsWith('BOOTSTRAP_STATE_DIR='));
      expect(dirAssignment).toContain('/var/lib/papercusp-bootstrap');
      // Not $STATE_ROOT (/var/lib/papercusp): the service user owns it and could forge the marker.
      expect(dirAssignment).not.toMatch(/\/var\/lib\/papercusp\//);
      expect(lines).toContain('BOOTSTRAP_COMPLETE_MARKER="$BOOTSTRAP_STATE_DIR/complete"');
      const mkdir = lines.indexOf('install -d -o root -g root -m 0700 "$BOOTSTRAP_STATE_DIR"');
      const write = lines.indexOf('printf "%s %s\\n" "$BOOTSTRAP_FINGERPRINT" "$BOOT_ID" > "$BOOTSTRAP_COMPLETE_MARKER.next"');
      expect(mkdir).toBeGreaterThan(0);
      expect(write).toBe(mkdir + 1);
      expect(script).not.toContain('$RUNTIME_ROOT/.bootstrap-complete');
    }
    // bootc: /opt is part of the immutable image, so nothing may redirect output into $RUNTIME_ROOT.
    expect(buildWorkspaceHostBootstrap(bootcInput())).not.toMatch(/>\s*"?\$RUNTIME_ROOT/);
  });

  it('attests bootc runtime confidentiality without refusing the image a+rx executables', () => {
    const oldShape = '-type f -o -type d \\) -perm -0004';
    const ubuntuLines = buildWorkspaceHostBootstrap(input()).split('\n');
    const bootcLines = buildWorkspaceHostBootstrap(bootcInput()).split('\n');
    const oldGuard = ubuntuLines.find((l) => l.includes(oldShape));
    const parents = bootcLines.find((l) => l.startsWith('[[ "$(stat -c %a "$RUNTIME_ROOT"'));
    const tree = bootcLines.find((l) => l.includes('-type f ! -perm /111 \\) \\) -perm -0004'));
    expect(oldGuard).toBeDefined();
    expect(bootcLines.some((l) => l.includes(oldShape))).toBe(false);
    expect(parents).toBeDefined();
    expect(tree).toBeDefined();
    expect(parents).toContain('die "runtime release tree must not be world-readable"');
    expect(tree).toContain('die "runtime release tree must not be world-readable"');

    // A tree shaped like the image (measured on image A r62b): parents 0750, inner dirs 0750,
    // executables 0755, data 0640, current -> releases/<version>.
    const runGuards = (guards: string[], mutate: (root: string) => void = () => {}) => {
      const root = mkdtempSync(join(tmpdir(), 'wh-runtime-perms-'));
      try {
        const release = join(root, 'releases', '0.0.21-test');
        mkdirSync(join(release, 'bin'), { recursive: true });
        writeFileSync(join(release, 'bin', 'node'), '#!/bin/sh\n');
        writeFileSync(join(release, 'serve.mjs'), 'export {};\n');
        symlinkSync('releases/0.0.21-test', join(root, 'current'));
        for (const d of [root, join(root, 'releases'), release, join(release, 'bin')]) chmodSync(d, 0o750);
        chmodSync(join(release, 'bin', 'node'), 0o755);
        chmodSync(join(release, 'serve.mjs'), 0o640);
        mutate(root);
        const script = [`RUNTIME_ROOT=${JSON.stringify(root)}`, 'die() { echo "$1" >&2; exit 1; }', ...guards].join('\n');
        return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const bootcGuards = [parents as string, tree as string];
    const release = (root: string) => join(root, 'releases', '0.0.21-test');

    // Positive control: the ubuntu predicate rejects the image shape, which is the chain10 failure.
    expect(runGuards([oldGuard as string]).status).not.toBe(0);
    expect(runGuards(bootcGuards).status).toBe(0);
    // Every other world-readable shape is still refused.
    expect(runGuards(bootcGuards, (r) => chmodSync(join(release(r), 'serve.mjs'), 0o644)).status).not.toBe(0);
    expect(runGuards(bootcGuards, (r) => chmodSync(join(release(r), 'bin'), 0o755)).status).not.toBe(0);
    expect(runGuards(bootcGuards, (r) => chmodSync(join(r, 'releases'), 0o755)).status).not.toBe(0);
    expect(runGuards(bootcGuards, (r) => chmodSync(release(r), 0o751)).status).not.toBe(0);
    const refused = runGuards(bootcGuards, (r) => chmodSync(r, 0o755));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('runtime release tree must not be world-readable');
  });

  /**
   * WI-10006110: every AWS bootc clean room died at systemd's DEFAULT 90s start timeout
   * ("start-post operation timed out") with nothing to say what the server was waiting on,
   * because service_diagnostics only runs after systemd has killed it. The unit must
   * declare its own start budget, and the start must be sampled while it is in flight.
   */
  it('declares a start budget and samples the service start in flight (WI-10006110)', () => {
    const script = buildWorkspaceHostBootstrap(input({ action: 'upgrade' }));
    const lines = script.split('\n');
    const unitAt = lines.indexOf('cat > "/etc/systemd/system/$SERVICE_NAME.service" <<PAPERCUSP_SERVICE');
    const unitEnd = lines.indexOf('PAPERCUSP_SERVICE', unitAt + 1);
    const budgetAt = lines.indexOf('SERVICE_START_TIMEOUT_SEC=600');
    expect(unitAt).toBeGreaterThanOrEqual(0);
    expect(budgetAt).toBeGreaterThanOrEqual(0);
    expect(budgetAt).toBeLessThan(unitAt);
    expect(lines.slice(unitAt, unitEnd)).toContain('TimeoutStartSec=$SERVICE_START_TIMEOUT_SEC');
    // chain8: papercusp-health's own 120s default gave up long before the 600s start budget.
    // Its budget must come from the start budget and stay below it, inside the probe's 1..600.
    const healthAt = lines.indexOf('SERVICE_HEALTH_TIMEOUT_SEC=$((SERVICE_START_TIMEOUT_SEC - 30))');
    expect(healthAt).toBeGreaterThan(budgetAt);
    expect(healthAt).toBeLessThan(unitAt);
    expect(lines.slice(unitAt, unitEnd)).toContain(
      'Environment=PAPERCUSP_HEALTH_TIMEOUT_SEC=$SERVICE_HEALTH_TIMEOUT_SEC',
    );
    const rendered = spawnSync(
      'bash',
      ['-c', [...lines.slice(budgetAt, healthAt + 1), 'echo "$SERVICE_START_TIMEOUT_SEC $SERVICE_HEALTH_TIMEOUT_SEC"'].join('\n')],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const [startBudget, healthBudget] = rendered.stdout.trim().split(' ').map(Number);
    expect(healthBudget).toBeGreaterThanOrEqual(1);
    expect(healthBudget).toBeLessThanOrEqual(600);
    expect(healthBudget).toBeLessThan(startBudget);

    const from = lines.indexOf('START_SAMPLE_LOG=""');
    const to = lines.indexOf('if service_restart_needed; then');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wh-start-diag-'));
    try {
      writeFileSync(join(stateRoot, 'server.log'), 'embedded-pg: waiting for postmaster\n');
      const harness = [
        'set -euo pipefail',
        `STATE_ROOT=${JSON.stringify(stateRoot)}`,
        // The AVC dump is shared with die() (WI-10006258) and only speaks on an SELinux host.
        'selinuxenabled() { return 0; }',
        shellFunction(lines.join('\n'), 'selinux_denials'),
        ...lines.slice(from, to),
        'start_sampler',
        'sleep 1',
        'stop_sampler',
        'start_diagnostics',
      ].join('\n');
      const started = Date.now();
      const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 20_000 });
      expect(run.status).toBe(0);
      // The stopped sampler must not hold the caller's output pipe open (its sleep is 10s).
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(run.stderr).toContain('--- start samples: first, then last');
      expect(run.stderr).toMatch(/=== start sample t\+\d+s/);
      expect(run.stderr).toContain('cpustat cpu');
      expect(run.stderr).toContain(`## ${join(stateRoot, 'server.log')}`);
      expect(run.stderr).toContain('embedded-pg: waiting for postmaster');
      expect(run.stderr).toContain('--- SELinux denials this boot ---');
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  /**
   * WI-10004242, measured on avi-test r62b 2026-09-30: GCE re-ran the whole bootstrap on a reboot
   * and restarted the already-running service at 11:19:23Z, killing a desktop the customer had
   * opened at 11:18:58Z. The restart may be skipped ONLY on a later boot re-running a bootstrap
   * that completed, with `current` unchanged and the unit active. Runs the rendered function.
   */
  describe('service_restart_needed (WI-10004242)', () => {
    const script = buildWorkspaceHostBootstrap(input({ action: 'upgrade' }));
    const lines = script.split('\n');
    const start = lines.indexOf('service_restart_needed() {');
    const end = lines.indexOf('}', start);
    const fn = lines.slice(start, end + 1).join('\n');
    const fingerprint = /^BOOTSTRAP_FINGERPRINT=([a-f0-9]{64})$/m.exec(script)?.[1] ?? '';

    function restartNeeded(opts: {
      marker?: string;
      previousRelease?: string;
      currentRelease?: string;
      unitState?: string;
    }): boolean {
      const root = mkdtempSync(join(tmpdir(), 'wi10004242-'));
      try {
        const runtimeRoot = join(root, 'opt');
        mkdirSync(join(runtimeRoot, 'releases', 'r1'), { recursive: true });
        mkdirSync(join(runtimeRoot, 'releases', 'r2'), { recursive: true });
        symlinkSync(join(runtimeRoot, 'releases', opts.currentRelease ?? 'r1'), join(runtimeRoot, 'current'));
        const marker = join(runtimeRoot, '.bootstrap-complete');
        if (opts.marker !== undefined) writeFileSync(marker, opts.marker);
        const harness = [
          'set -euo pipefail',
          `systemctl() { [[ "$1" == is-active ]] && echo ${opts.unitState ?? 'active'}; }`,
          `RUNTIME_ROOT=${runtimeRoot}`,
          'SERVICE_NAME=papercusp-workspace',
          `BOOTSTRAP_FINGERPRINT=${fingerprint}`,
          `BOOTSTRAP_COMPLETE_MARKER=${marker}`,
          'BOOT_ID=boot-now',
          `PREVIOUS_TARGET=${join(runtimeRoot, 'releases', opts.previousRelease ?? 'r1')}`,
          fn,
          'if service_restart_needed; then echo RESTART; else echo KEEP; fi',
        ].join('\n');
        const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        return run.stdout.trim() === 'RESTART';
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('renders a deterministic fingerprint of the script and the function around the restart', () => {
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(start).toBeGreaterThan(0);
      expect(buildWorkspaceHostBootstrap(input({ action: 'upgrade' }))).toBe(script);
      expect(buildWorkspaceHostBootstrap(input({ action: 'install' }))).not.toContain(`BOOTSTRAP_FINGERPRINT=${fingerprint}`);
      expect(script).not.toContain('__PAPERCUSP_BOOTSTRAP_FINGERPRINT__');
    });

    it('writes the completion marker only after the attestation, just before "bootstrap complete"', () => {
      const writeAt = lines.indexOf('mv -Tf "$BOOTSTRAP_COMPLETE_MARKER.next" "$BOOTSTRAP_COMPLETE_MARKER"');
      expect(writeAt).toBeGreaterThan(lines.findIndex((line) => line.startsWith('ATTESTATION_PATH=')));
      expect(lines[writeAt + 1]).toBe('log "bootstrap complete"');
    });

    it('keeps the service running only on a later boot of a completed, identical bootstrap', () => {
      expect(restartNeeded({ marker: `${fingerprint} boot-earlier\n` })).toBe(false);
    });

    it('restarts on a first run, a changed rendering, a same-boot re-run, a release switch, or an inactive unit', () => {
      // Calibration: the keep case above passes with exactly these defaults.
      expect(restartNeeded({})).toBe(true);
      expect(restartNeeded({ marker: `${'0'.repeat(64)} boot-earlier\n` })).toBe(true);
      expect(restartNeeded({ marker: `${fingerprint} boot-now\n` })).toBe(true);
      expect(restartNeeded({ marker: `${fingerprint}\n` })).toBe(true);
      expect(restartNeeded({ marker: `${fingerprint} boot-earlier\n`, currentRelease: 'r2' })).toBe(true);
      expect(restartNeeded({ marker: `${fingerprint} boot-earlier\n`, unitState: 'activating' })).toBe(true);
      expect(restartNeeded({ marker: `${fingerprint} boot-earlier\n`, unitState: 'failed' })).toBe(true);
    });
  });

  it('supports explicit distinct identities and rejects privileged or shared identities', () => {
    const script = buildWorkspaceHostBootstrap(
      input({
        service: {
          name: 'papercusp-workspace',
          port: 3070,
          user: 'papercusp-svc',
          group: 'papercusp-svc',
        },
        isolation: {
          workspaceUser: 'customer-workspace',
          workspaceGroup: 'customer-workspace',
        },
      }),
    );
    expect(script).toContain("SERVICE_USER='papercusp-svc'");
    expect(script).toContain("WORKSPACE_USER='customer-workspace'");

    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          service: { name: 'papercusp-workspace', port: 3070, user: 'root' },
        }),
      ),
    ).toThrow(/service.user must be a safe Linux name/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { workspaceUser: 'papercusp' } }),
      ),
    ).toThrow(/workspace SSH user must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { workspaceGroup: 'papercusp' } }),
      ),
    ).toThrow(/workspace SSH group must differ/);
  });

  it("grants only the two fixed protocol argv through root-owned conduits", () => {
    const script = buildWorkspaceHostBootstrap(input());
    const conduit = script.slice(
      script.indexOf(
        'install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"',
      ),
      script.indexOf('cat > "/etc/systemd/system/$SERVICE_NAME.service"'),
    );

    expect(conduit).toContain(
      "papercusp-remote-initializer --protocol-version papercusp-gcp-iap-initialization-v4 --json-stdin",
    );
    expect(conduit).toContain(
      "papercusp-deliver-material --protocol-version papercusp-workspace-host-credential-delivery-v1 --json-stdin",
    );
    expect(conduit.match(/NOPASSWD:/g)).toHaveLength(1);
    expect(conduit).not.toMatch(
      /ALL=\(ALL|NOPASSWD:\s*ALL|\*|\beval\b|\bsh -c\b/,
    );
    expect(conduit).toContain(
      "Defaults!PAPERCUSP_WORKSPACE_HOST_INITIALIZER env_reset, !setenv",
    );
    expect(conduit).toContain(
      "Defaults!PAPERCUSP_WORKSPACE_HOST_DELIVERY env_reset, !setenv",
    );
  });

  it("dispatches both privileged conduits through the bundled interpreter, in the wrapper and the sudoers allowlist alike", () => {
    // REGRESSION (p046-canary-03, 2026-09-02). Both targets are `#!/usr/bin/env node` scripts and
    // the sudoers entries pin `env_reset, !setenv`, so the shebang resolves `node` against sudo's
    // secure_path — which never contains the bundle's own runtime. Every privileged invocation
    // therefore died with `/usr/bin/env: 'node': No such file or directory` (exit 127) before
    // reading its request, while file ownership, mode and `visudo -cf` all reported green.
    //
    // The sibling case above could not catch it: it asserts the SUBSTRING
    // "papercusp-remote-initializer --protocol-version …", which stays true no matter what does
    // (or does not) precede the script. So this pins the whole command VECTOR — interpreter, then
    // script, then argv — which is what sudo actually matches and what execve actually needs.
    const script = buildWorkspaceHostBootstrap(input());
    const node = `${WORKSPACE_HOST_RUNTIME_ROOT}/current/${DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.node}`;

    for (const [target, argv] of [
      [
        DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.remoteInitializer,
        WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV,
      ],
      [
        DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.credentialDelivery,
        WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV,
      ],
    ] as const) {
      const program = `${WORKSPACE_HOST_RUNTIME_ROOT}/current/${target}`;
      // The wrapper's exec line: sudo, then interpreter, then script — never the script alone.
      expect(script).toContain(
        `exec /usr/bin/sudo -n -- '${node}' '${program}' "$@"`,
      );
      // The allowlist repeats that same vector; a mismatch here refuses the invocation above.
      expect(script).toContain(`${node} ${program} ${argv.join(" ")}`);
      expect(script).not.toContain(`exec /usr/bin/sudo -n -- '${program}'`);
    }

    // And the stage verifies at run time what static emission cannot: that the pinned interpreter
    // is really present and executable on the host being bootstrapped.
    expect(script).toContain(
      'die "conduit interpreter is missing or not executable',
    );
  });

  it('rejects non-public provenance, unsafe entrypoints, and secret-shaped metadata', () => {
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          release: {
            ...input().release,
            bundleUrl: 'http://example.test/server.tgz',
          },
        }),
      ),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          entrypoints: { operator: '../../tmp/operator' },
        }),
      ),
    ).toThrow(/safe relative release path/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          publicMetadata: { apiToken: 'must-not-be-rendered' },
        }),
      ),
    ).toThrow(/Secret-shaped field/);
  });

  // D-106 / WI-41712. requirePublicHttpsUrl proves only that the URL is well-formed,
  // credential-free HTTPS — it never relates the URL to the digest the release pins. Each case
  // below is well-formed HTTPS and passes every OTHER bootstrap check, so each one FAILS if the
  // shared addressing rule is not wired in. That is the point: these are the falsifiers for the
  // guard, not decoration around it.
  // D-238. harden-os sets `AuthenticationMethods publickey` + `AllowUsers $WORKSPACE_USER` and
  // locks the workspace account, so the authorized_keys this renders is the ONLY way back into
  // the host. Provider metadata cannot substitute: the GCP provider sets enable-oslogin=TRUE and
  // block-project-ssh-keys=TRUE, and the workspace account is a local user OS Login never answers
  // for. A render that omits it produced a host that bootstrapped, attested "healthy", and was
  // unreachable — measured on p046-canary-04.
  describe('workspace authorized keys (D-238)', () => {
    const KEY =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller';

    it('installs the authorized key for the workspace account, base64-encoded', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        `WORKSPACE_AUTHORIZED_KEYS_B64='${Buffer.from(`${KEY}\n`, 'utf8').toString('base64')}'`,
      );
      expect(script).toContain(
        'printf %s "$WORKSPACE_AUTHORIZED_KEYS_B64" | base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
      expect(script).toContain(
        'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER/.ssh"',
      );
      expect(script).toContain(
        'chmod 0600 "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
    });

    // The ordering IS the correctness property, not a style preference: writing the key after the
    // sshd reload leaves a window in which the host is hardened and not yet reachable.
    it('installs the key BEFORE sshd hardening takes effect', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const keyInstalled = script.indexOf(
        '/home/$WORKSPACE_USER/.ssh/authorized_keys',
      );
      const hardened = script.indexOf('AllowUsers $WORKSPACE_USER');
      const reloaded = script.indexOf('systemctl reload-or-restart ssh');
      expect(keyInstalled).toBeGreaterThan(-1);
      expect(keyInstalled).toBeLessThan(hardened);
      expect(hardened).toBeLessThan(reloaded);
    });

    it('keeps the hosted PTY private key with the service and grants only loopback customer SSH', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const keyReset = script.indexOf('base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"');
      const keyAppend = script.indexOf('restrict,pty,from="127.0.0.1"');
      const sshReload = script.indexOf('systemctl reload-or-restart ssh');
      expect(keyReset).toBeGreaterThan(-1);
      expect(keyAppend).toBeGreaterThan(keyReset);
      expect(keyAppend).toBeLessThan(sshReload);
      expect(script).toContain(`HOSTED_PTY_SSH_KEY='${WORKSPACE_HOST_HOSTED_PTY_SSH_KEY}'`);
      expect(script).toContain(`HOSTED_PTY_KNOWN_HOSTS='${WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS}'`);
      expect(script).toContain('runuser -u "$SERVICE_USER" -- ssh-keygen -y -f "$HOSTED_PTY_SSH_KEY"');
      expect(script).toContain('ssh_host_ed25519_key.pub');
      expect(script).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r "$HOSTED_PTY_SSH_KEY"');
      expect(script).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r "$STATE_ROOT/embedded-pg"');
      expect(script).toContain('runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PATH=/usr/bin:/bin /usr/bin/ssh -F /dev/null -tt');
      expect(script).toContain('/var/lib/papercusp/embedded-pg');
      expect(script).toContain('/home/papercusp-agent');
      expect(script).toContain('hosted customer PTY loopback authentication or isolation failed');
      expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
    });

    // p046-canary-08: bootstrap aborted in phase:harden-os with
    //   Missing privilege separation directory: /run/sshd   (sshd -t, exit 255)
    // /run/sshd is ssh.service's systemd RuntimeDirectory, so systemd removes it whenever that
    // unit stops — which the apt step in this SAME phase causes whenever it upgrades
    // openssh-server. That made the step's success depend on whether the boot happened to pull an
    // openssh update: canary-07 passed, canary-08 failed six hours later on "3 upgraded".
    // Reproduced with a negative control (ubuntu:24.04 + openssh-server): with /run/sshd removed
    // `sshd -t` prints that exact line and exits 255; after `mkdir -p /run/sshd` it exits 0.
    it('creates the sshd privilege-separation directory BEFORE validating the config', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const privsep = script.indexOf('install -d -m 0755 -o root -g root /run/sshd');
      const validated = script.indexOf('sshd -t');
      expect(privsep).toBeGreaterThan(-1);
      expect(validated).toBeGreaterThan(-1);
      // Ordering is the whole property: created after the test would not prevent the abort.
      expect(privsep).toBeLessThan(validated);
    });

    // The line immediately after `sshd -t` had the same latent dependency: `systemctl reload` of
    // a STOPPED unit fails, and an openssh upgrade can leave ssh.service stopped. Under
    // `set -euo pipefail` that aborts the bootstrap one line past the trap fixed above.
    it('applies the hardened config with reload-or-restart, so a stopped ssh.service is not fatal', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'systemctl reload-or-restart ssh 2>/dev/null || systemctl reload-or-restart sshd',
      );
      // A bare `systemctl reload ssh` is precisely what regresses this.
      expect(script).not.toMatch(/systemctl reload ssh\b/);
    });

    it('fails the bootstrap rather than leaving an empty authorized_keys', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die',
      );
    });

    it('refuses to render a host nobody can reach', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(input({ workspaceAuthorizedKeys: [] })),
      ).toThrow(/at least one OpenSSH public key/);
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            workspaceAuthorizedKeys: undefined as unknown as readonly string[],
          }),
        ),
      ).toThrow(/at least one OpenSSH public key/);
    });

    it('refuses malformed keys and authorized_keys option prefixes', () => {
      for (const bad of [
        'not-a-key',
        'ssh-ed25519',
        `command="/bin/false" ${KEY}`,
        `${KEY}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma smuggled`,
      ]) {
        expect(() =>
          buildWorkspaceHostBootstrap(
            input({ workspaceAuthorizedKeys: [bad] }),
          ),
        ).toThrow(/plain OpenSSH public key line/);
      }
    });

    it('round-trips a comment containing shell metacharacters byte-for-byte', () => {
      const awkward = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma it's "me" $(whoami)`;
      const script = buildWorkspaceHostBootstrap(
        input({ workspaceAuthorizedKeys: [awkward] }),
      );
      const encoded = /WORKSPACE_AUTHORIZED_KEYS_B64='([^']+)'/.exec(script);
      expect(encoded).not.toBeNull();
      expect(
        Buffer.from(encoded![1], 'base64').toString('utf8'),
      ).toBe(`${awkward}\n`);
    });

    it('authorizes several distinct keys, one per line', () => {
      const second =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq second';
      const script = buildWorkspaceHostBootstrap(
        input({ workspaceAuthorizedKeys: [KEY, second] }),
      );
      const encoded = /WORKSPACE_AUTHORIZED_KEYS_B64='([^']+)'/.exec(script);
      expect(Buffer.from(encoded![1], 'base64').toString('utf8')).toBe(
        `${KEY}\n${second}\n`,
      );
    });

    // Refused, not silently deduped: a repeated key means the caller assembled the list wrong,
    // and quietly accepting it hides that from whoever has to debug access later.
    it('refuses a repeated key', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({ workspaceAuthorizedKeys: [KEY, KEY] }),
        ),
      ).toThrow(/must not repeat a key/);
    });
  });

  // EI-22185970114422986 — the CLASS the lockout belonged to: a step that reports success on a
  // property it never observed. `checks` is serialized into the attestation by the RENDERER as
  // `{ name, ok: true }` for every name, and `validateWorkspaceHostBootstrapAttestation` then
  // requires exactly that — so the array could not report a failure of anything. The design
  // (every name has a `die` guard upstream, so reaching attest-health is the proof) is sound and
  // is kept; what was missing is anything BINDING a name to its guard.
  describe('attested checks are bound to a host-side observation (EI-22185970114422986)', () => {
    // PER MODEL (P-306). Running this against the Ubuntu render alone would leave the bootc
    // render completely unpinned while the suite stayed green — and a bootc host attests four
    // names whose observations exist nowhere else, so that is exactly where an unbacked check
    // could hide.
    it.each(WORKSPACE_HOST_MODELS)(
      'renders the observation that establishes every attested check (%s)',
      (hostModel) => {
        const script = buildWorkspaceHostBootstrap(
          hostModel === 'bootc-image' ? bootcInput() : input(),
        );
        const attestingOnNothing = workspaceHostBootstrapChecks(
          hostModel,
        ).filter(
          (name) =>
            !script.includes(WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE[name]),
        );
        // Named, never counted: the failure has to say WHICH check is attesting on nothing.
        expect(attestingOnNothing).toEqual([]);
      },
    );

    // The complement, and it is the half that catches a check name deleted from a model without
    // its evidence entry going too — leaving a fragment pinned to a script nothing renders.
    it.each(WORKSPACE_HOST_MODELS)(
      'renders NO observation belonging to the other host model (%s)',
      (hostModel) => {
        const script = buildWorkspaceHostBootstrap(
          hostModel === 'bootc-image' ? bootcInput() : input(),
        );
        const foreign = WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES.filter(
          (name) =>
            !workspaceHostBootstrapChecks(hostModel).includes(name) &&
            script.includes(WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE[name]),
        );
        expect(foreign).toEqual([]);
      },
    );

    it('declares evidence for every attested name and for no name that is not attested', () => {
      expect(
        Object.keys(WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE).sort(),
      ).toEqual([...WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES].sort());
    });

    it('partitions every check name into exactly one model, with nothing orphaned', () => {
      const perModel = WORKSPACE_HOST_MODELS.flatMap((model) => [
        ...workspaceHostBootstrapChecks(model),
      ]);
      // Every name reachable from some model…
      expect([...new Set(perModel)].sort()).toEqual(
        [...WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES].sort(),
      );
      // …and the ONLY names both models share are the shared ones. A model-specific check that
      // drifts into both lists would silently re-create the flat list this split replaced.
      const inBoth = [...new Set(perModel)].filter(
        (name) =>
          perModel.filter((candidate) => candidate === name).length ===
          WORKSPACE_HOST_MODELS.length,
      );
      expect(inBoth.sort()).toEqual(
        [...WORKSPACE_HOST_BOOTSTRAP_SHARED_CHECKS].sort(),
      );
    });

    // A guard that has never failed is a guard nobody has tested. The map is only worth its line
    // count if an unrendered fragment is actually REPORTED, so prove that here rather than
    // trusting it — with a fabricated copy, so nothing in the tree is mutated to run the control.
    it('is falsifiable: a check whose observation is not rendered is reported by name', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const fabricated: Record<string, string> = {
        ...WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE,
        'ssh-forwarding-policy': 'die "no bootstrap has ever emitted this line"',
      };
      const attestingOnNothing = workspaceHostBootstrapChecks(
        'ubuntu-release-bundle',
      ).filter((name) => !script.includes(fabricated[name]));
      expect(attestingOnNothing).toEqual(['ssh-forwarding-policy']);
    });
  });

  // The second half of the same item: the property the ORIGINAL host died of was not among the
  // attested checks at all, and its only guard fired five phases before `healthy` was claimed.
  describe('attest-time SSH reachability observation (EI-22185970114422986)', () => {
    it('re-observes authorized_keys where healthy is CLAIMED, not only in harden-os', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const hardenGuard = script.indexOf(
        'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die',
      );
      const attestGuard = script.indexOf(
        '[[ -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" ]] || die "workspace authorized_keys is unreadable or empty at attest time',
      );
      const attestationWritten = script.indexOf('ATTESTATION_PATH=');
      expect(hardenGuard).toBeGreaterThan(-1);
      // Ordering IS the property: an observation after the attestation cannot inform it, and one
      // that only runs in harden-os cannot speak for the host minutes later.
      expect(attestGuard).toBeGreaterThan(hardenGuard);
      expect(attestGuard).toBeLessThan(attestationWritten);
    });

    it('asserts sshd will actually read the key file this bootstrap wrote', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'stat -c "%U %a" "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
      expect(script).toContain(
        'grep -Fx "pubkeyauthentication yes" <<<"$SSHD_POLICY"',
      );
      expect(script).toContain(
        'grep -Eq "^authorizedkeysfile .*\\.ssh/authorized_keys" <<<"$SSHD_POLICY"',
      );
    });

    it('names the check so the attestation is not silent about reachability', () => {
      expect(workspaceHostBootstrapChecks('ubuntu-release-bundle')).toContain(
        'workspace-ssh-authorized-keys',
      );
      // The validator iterates the same list, so an attestation that omits the new check is
      // refused rather than accepted as healthy.
      const verdict = validateWorkspaceHostBootstrapAttestation(
        attestation({
          checks: workspaceHostBootstrapChecks('ubuntu-release-bundle')
            .filter((name) => name !== 'workspace-ssh-authorized-keys')
            .map((name) => ({ name, ok: true as const })),
        }),
        input(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        "required bootstrap check 'workspace-ssh-authorized-keys' did not pass",
      );
    });
  });

  describe('release addressing (D-106)', () => {
    it('accepts the canonical digest-derived artifact URLs', () => {
      expect(() => buildWorkspaceHostBootstrap(input())).not.toThrow();
    });

    it('rejects a mutable release channel even with a well-formed digest', () => {
      // The exact shape that motivated the rule: a valid bundleSha256 sitting next to a URL that
      // can be re-pointed at different bytes tomorrow, interpolated into a script running as root.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: `${ARTIFACT_BASE}/latest/server.tgz`,
              signatureUrl: `${ARTIFACT_BASE}/latest/server.tgz.minisig`,
            },
          }),
        ),
      ).toThrow(/mutable release channel/);
    });

    it('rejects a content-addressed URL that addresses a different digest', () => {
      // Well-shaped and immutable, but it pins someone else's bundle. This must NOT fall through
      // to the version-embedding rule and be accepted as "immutable enough".
      const wrong = deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST);
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: wrong.bundleUrl,
              signatureUrl: wrong.signatureUrl,
            },
          }),
        ),
      ).toThrow(/is content-addressed at/);
    });

    it('rejects a signature that is not the detached companion of the bundle', () => {
      // A valid signature over a DIFFERENT artifact would otherwise satisfy verification.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST)
                .signatureUrl,
            },
          }),
        ),
      ).toThrow(/suffixed with \.minisig/);
    });

    it('rejects a digest that merely appears in the query string', () => {
      // A query parameter does not determine which bytes the origin serves.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: `${ARTIFACT_BASE}/server.tgz?digest=${DIGEST}`,
              signatureUrl: `${ARTIFACT_BASE}/server.tgz?digest=${DIGEST}.minisig`,
            },
          }),
        ),
      ).toThrow();
    });
  });
});

describe('workspace-host native dependency contract', () => {
  it('parses and normalizes the readelf NEEDED union deterministically', () => {
    const output = [
      ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
      ' 0x0000000000000001 (NEEDED)             Shared library: [libatomic.so.1]',
      ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
      ' 0x000000000000000e (SONAME)             Library soname: [ignored.so.1]',
    ].join('\n');
    expect(parseWorkspaceHostReadelfNeeded(output)).toEqual([
      'libatomic.so.1',
      'libstdc++.so.6',
    ]);
    expect(normalizeWorkspaceHostSoname('  [libasound.so.2]  ')).toBe(
      'libasound.so.2',
    );
  });

  it('subtracts glibc and bundle-internal libraries before checking providers', () => {
    const result = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: [
        ...WORKSPACE_HOST_GLIBC_SONAMES,
        'libonnxruntime.so.1',
        'libatomic.so.1',
        'libasound.so.2',
      ],
      bundleInternalSonames: ['libonnxruntime.so.1'],
    });
    expect(result.ok).toBe(true);
    expect(result.externalSonames).toEqual([
      'libasound.so.2',
      'libatomic.so.1',
    ]);
    expect(result.requiredAptPackages).toEqual([
      'libasound2t64',
      'libatomic1',
    ]);
    expect(result.missingAptPackages).toEqual([]);
  });

  it('fails closed for unknown SONAMEs and missing apt providers', () => {
    const unknown = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: ['libnew-native.so.1'],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.unknownSonames).toEqual(['libnew-native.so.1']);

    const missing = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: ['libatomic.so.1', 'libstdc++.so.6'],
      aptPackages: ['libatomic1'],
    });
    expect(missing.ok).toBe(false);
    expect(missing.unknownSonames).toEqual([]);
    expect(missing.missingAptPackages).toEqual(['libstdc++6']);
  });

  it('keeps the provider map and bootstrap apt contract aligned', () => {
    const result = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: Object.keys(WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE),
    });
    expect(result.ok).toBe(true);
    expect(result.requiredAptPackages).toEqual(
      expect.arrayContaining([
        'libasound2t64',
        'libatomic1',
        'libgcc-s1',
        'libstdc++6',
      ]),
    );
  });
});

describe('workspace-host bootstrap attestation', () => {
  it('parses and accepts an exact release/runtime/migration/service result', () => {
    const expected = attestation();
    const encoded = Buffer.from(JSON.stringify(expected), 'utf8').toString(
      'base64',
    );
    const parsed = parseWorkspaceHostBootstrapAttestation(
      `log line\n${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}${encoded}\n`,
    );
    expect(parsed).toEqual(expected);
    expect(validateWorkspaceHostBootstrapAttestation(parsed, input())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects provenance, migration, runtime, service, and check drift together', () => {
    const drifted = attestation({
      release: {
        ...attestation().release,
        source: deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST)
          .bundleUrl,
      },
      migration: { id: 'schema-old', applied: true },
      runtime: {
        ...attestation().runtime,
        nodeMajor: 20,
        pui: false as true,
      },
      service: {
        ...attestation().service,
        user: 'unexpected-service',
        bindHost: '0.0.0.0' as '127.0.0.1',
      },
      isolation: {
        ...attestation().isolation,
        // Post-D-248 there are TWO violating read shapes and they point opposite ways: the SSH
        // login reading the runtime is D-043's violation, and the agent identity NOT reading it
        // is a host with no runnable agents. Drift both at once so the validator has to name
        // them separately rather than collapsing to one message.
        runtimeReadableByWorkspaceUser: true as false,
        runtimeReadableByAgentUser: false as true,
        runtimeWritableByAgentUser: true as false,
        agentHomeReadableBySshUser: true as false,
        sudo: true as false,
      },
      // Dropped BY NAME, not by position. `.slice(1)` used to mean "drop ubuntu-24.04" only
      // because that name happened to sit first in a flat list; the per-model split reorders it,
      // and a positional drop then removes a different check than the one asserted below —
      // which reads as this test breaking rather than as the coupling it actually is.
      checks: workspaceHostBootstrapChecks('ubuntu-release-bundle')
        .filter((name) => name !== 'ubuntu-24.04')
        .map((name) => ({ name, ok: true as const })),
    });
    const result = validateWorkspaceHostBootstrapAttestation(drifted, input());
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'release source mismatch',
        'migration id mismatch',
        'Node runtime is below the requested floor',
        'service user mismatch',
        'operator must bind to loopback',
        'workspace SSH user can read the Papercusp runtime (D-043)',
        'agent identity cannot read the runtime it must execute agents from',
        'workspace SSH user can read the delivered agent credential home',
        'an unprivileged identity can write the runtime',
        'workspace SSH user has privileged runtime membership',
        "required bootstrap check 'ubuntu-24.04' did not pass",
      ]),
    );
  });

  it('fails malformed remote JSON closed instead of throwing through the provider workflow', () => {
    expect(
      validateWorkspaceHostBootstrapAttestation({ status: 'healthy' }, input()),
    ).toEqual({
      ok: false,
      errors: ['bootstrap attestation has an invalid shape'],
    });
  });

  // P-306 half B. Every test here exists to refuse ONE specific way a bootc host could claim a
  // property only the tarball host can establish — which is D-262's trap, and the reason D-280
  // ordered the port before condition 2.
  describe('bootc-image host model', () => {
    function bootcAttestation(
      overrides: Partial<BootcAttestation> = {},
    ): BootcAttestation {
      const base = attestation();
      return {
        ...base,
        hostModel: 'bootc-image',
        bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        release: {
          version: base.release.version,
          source: workspaceHostBootcPinnedImageRef(bootcInput().bootc!),
          imageDigest: bootcInput().bootc!.imageDigest,
          signaturePolicyPath: bootcInput().bootc!.signaturePolicyPath,
          signatureVerified: true,
        },
        isolation: {
          ...base.isolation,
          updateMode: 'bootc-atomic-image-swap',
        },
        checks: workspaceHostBootstrapChecks('bootc-image').map((name) => ({
          name,
          ok: true as const,
        })),
        ...overrides,
      };
    }

    it('accepts a well-formed bootc attestation', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        bootcAttestation(),
        bootcInput(),
      );
      expect(verdict.errors).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('renders the bootc update mode, never the release-swap one', () => {
      const script = buildWorkspaceHostBootstrap(bootcInput());
      expect(script).toContain(
        `updateMode:"${WORKSPACE_HOST_UPDATE_MODE_BY_MODEL['bootc-image']}"`,
      );
      expect(script).not.toContain('signed-atomic-release-swap');
    });

    // The whole tarball trust chain must be ABSENT from the render — not merely unused. A line
    // that downloads and minisign-verifies a bundle on a host whose release is the image would
    // be verifying something the host does not run.
    it.each(['curl ', 'minisign ', 'sha256sum ', 'apt-get ', 'ufw '])(
      'renders no bundle-model command: %s',
      (fragment) => {
        expect(buildWorkspaceHostBootstrap(bootcInput())).not.toContain(
          fragment,
        );
      },
    );

    it('stages by DIGEST and reboots rather than swapping a symlink', () => {
      const script = buildWorkspaceHostBootstrap(bootcInput());
      expect(script).toContain('bootc switch --retain');
      expect(script).toContain(WORKSPACE_HOST_BOOTSTRAP_STAGED_PREFIX);
      expect(script).toContain('systemctl reboot');
      // Pinned by digest, so the tag cannot decide what actually gets deployed.
      expect(script).toContain(`@${bootcInput().bootc!.imageDigest}`);
      // …and the symlink swap is gone with it.
      expect(script).not.toContain('$RUNTIME_ROOT/current.next');
    });

    // WI-10005754: /opt is immutable image content on this model, and D-314 bakes the runtime
    // root's access as group ownership that papercusp-host-prepare.service only VERIFIES. Any
    // write under it dies with EROFS on a booted host (the first AWS bootc clean room died here,
    // in harden-os), and a named-user ACL would also trip host-prepare's refusal.
    const runtimeRootWrites = (script: string): string[] => {
      const writer =
        /(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+|\belse\s+)'?(?:install|setfacl|chown|chmod|chgrp|mkdir|ln|rm|mv|cp|tar|touch|tee)\s/;
      return script
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .filter((line) => writer.test(line))
        .filter(
          (line) =>
            line.includes('$RUNTIME_ROOT') ||
            line.includes('${RUNTIME_ROOT') ||
            line.includes('/opt/papercusp'),
        )
        .map((line) => line.trim());
    };

    it('never writes the image-provided runtime root (WI-10005754)', () => {
      const script = buildWorkspaceHostBootstrap(bootcInput());
      expect(runtimeRootWrites(script)).toEqual([]);
      expect(script).toContain(
        'install -d -o root -g "$SERVICE_GROUP" -m 0750 /etc/papercusp',
      );
      expect(script).toContain('[[ -d "$RUNTIME_ROOT/releases" ]] || die');
    });

    // Calibration for the guard above: the bundle model still owns a writable runtime root, so
    // the SAME detector must flag exactly the two lines the bootc render used to carry. If this
    // ever comes back empty the detector is blind, and the bootc assertion passes vacuously.
    it('keeps the runtime-root creation and agent ACL on the bundle model, and the detector sees them (WI-10005754)', () => {
      const writes = runtimeRootWrites(buildWorkspaceHostBootstrap(input()));
      expect(writes).toContain(
        'install -d -o root -g "$SERVICE_GROUP" -m 0750 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" /etc/papercusp',
      );
      expect(writes).toContain(
        'setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"',
      );
    });

    // WI-10005830: on the bootc base `/usr/local` is a real directory inside the read-only `/usr`,
    // so the first AWS bootc clean room past install-runtime died in configure-service:
    //   install: cannot create regular file '/usr/local/bin/papercusp-workspace-host-initialize': Read-only file system
    // The image now links `/usr/local` to machine-local storage. Every OTHER `/usr` path is still
    // read-only, so the render may write under `/usr/local` (directly or through a conduit
    // variable) only after asserting that link, and may write nothing else under `/usr`.
    // `--shell /usr/sbin/nologin` names an existing program; it writes nothing.
    const usrWrites = (script: string): string[] => {
      const writer =
        /(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+|\belse\s+|\|\|\s*)'?(?:install|setfacl|chown|chmod|chgrp|mkdir|ln|rm|mv|cp|tar|touch|tee|useradd)\s/;
      return script
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .filter((line) => writer.test(line))
        .filter((line) => line.replaceAll('--shell /usr/sbin/nologin', '').includes('/usr/'))
        .map((line) => line.trim());
    };
    const outsideUsrLocal = (lines: string[]): string[] =>
      lines.filter((line) =>
        (line.replaceAll('--shell /usr/sbin/nologin', '').match(/\/usr\/[^\s"';)]*/g) ?? []).some(
          (path) => path !== '/usr/local' && !path.startsWith('/usr/local/'),
        ),
      );
    // Everything a bootc host can be asked to install: all three agent runtimes (OMP brings the
    // ollama runtime, its service account and the customer OMP copy) plus the hosted connector.
    const fullBootcRender = () =>
      buildWorkspaceHostBootstrap(
        bootcInput({
          agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS],
          hostedConnector: { controlPlaneOrigin: 'https://app.papercusp.com' },
        }),
      );
    const USR_LOCAL_ASSERTION = `[[ -L /usr/local && "$(readlink -f /usr/local)" == '${WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET}' ]]`;

    it('writes nothing under read-only /usr except through the machine-local /usr/local link (WI-10005830)', () => {
      const script = fullBootcRender();
      expect(outsideUsrLocal(usrWrites(script))).toEqual([]);
      // The ollama account's home is machine-local on this model: `--create-home` under
      // /usr/share would die on EROFS exactly like the conduit did.
      expect(script).toContain(`--home-dir ${WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL['bootc-image']} --create-home`);
      expect(script).not.toContain(WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL['ubuntu-release-bundle']);
    });

    it('asserts the /usr/local link in validate-host, before its first write through /usr/local (WI-10005830)', () => {
      const script = fullBootcRender();
      const assertion = script.indexOf(USR_LOCAL_ASSERTION);
      expect(assertion).toBeGreaterThan(script.indexOf(`phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[0]}'`));
      expect(assertion).toBeLessThan(script.indexOf(`phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[1]}'`));
      // The conduits are written through shell variables, so find the first write either way.
      const firstWrite = Math.min(
        ...[
          'install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"',
          'install -m 0755 -o root -g root -- "$AGENT_RUNTIME_OMP" /usr/local/bin/omp',
          '-C /usr/local --exclude=',
        ].map((needle) => {
          const at = script.indexOf(needle);
          expect(at, `render no longer contains: ${needle}`).toBeGreaterThan(-1);
          return at;
        }),
      );
      expect(assertion).toBeLessThan(firstWrite);
      expect(script).toContain('install -d -o root -g root -m 0755 /usr/local/bin /usr/local/sbin /usr/local/lib /usr/local/libexec');
    });

    // Calibration: the bundle model has a writable /usr, so it keeps the upstream ollama home and
    // never asserts the bootc link, and the SAME detector must see that write. If this ever comes
    // back empty the detector is blind, and the bootc assertion above passes vacuously.
    it('keeps /usr/share/ollama on the bundle model, and the detector sees it (WI-10005830)', () => {
      const script = buildWorkspaceHostBootstrap(input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }));
      const flagged = outsideUsrLocal(usrWrites(script));
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toContain(`--home-dir ${WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL['ubuntu-release-bundle']} --create-home`);
      expect(script).not.toContain(USR_LOCAL_ASSERTION);
    });

    it('preserves an explicit registry port and checks the baked namespace policy pin', () => {
      const image = '127.0.0.1:5096/papercusp/workspace-host:2026.9.4-1';
      const script = buildWorkspaceHostBootstrap(
        bootcInput({ bootc: { ...bootcInput().bootc!, image } }),
      );

      // The repository is the portion before the FINAL colon.  The old first-colon
      // split rendered `127.0.0.1@sha256:…`, silently discarding both the port and
      // the namespace.
      expect(script).toContain(
        "EXPECTED_IMAGE_REPO='127.0.0.1:5096/papercusp/workspace-host'",
      );
      expect(script).toContain(
        "EXPECTED_IMAGE_PINNED='127.0.0.1:5096/papercusp/workspace-host@sha256:",
      );
      expect(script).not.toContain("EXPECTED_IMAGE_REPO='127.0.0.1'");

      // Policy is authored at the exact path the specialised image build records,
      // and the generated check reads that namespace rather than guessing a leaf key.
      expect(script).toContain(
        `SIGNATURE_POLICY_SCOPE_PATH='${WORKSPACE_HOST_BOOTC_RELEASE_REGISTRY_SCOPE_PATH}'`,
      );
      expect(script).toContain('EXPECTED_POLICY_SCOPE="$(cat "$SIGNATURE_POLICY_SCOPE_PATH")"');
      expect(script).toContain('--arg scope "$EXPECTED_POLICY_SCOPE"');
    });

    it('uses bootc rollback for the rollback action', () => {
      const script = buildWorkspaceHostBootstrap(
        bootcInput({ action: 'rollback' }),
      );
      expect(script).toContain('bootc rollback');
      // ⛔ and fails closed on the database half rather than silently skipping it, which would
      // leave the newer schema behind an older runtime.
      expect(script).toContain(
        'bootc-image rollback cannot run the database rollback step yet',
      );
    });

    it('refuses an attestation claiming the release-swap update mode', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        bootcAttestation({
          isolation: {
            ...bootcAttestation().isolation,
            updateMode:
              'signed-atomic-release-swap' as unknown as 'bootc-atomic-image-swap',
          },
        }),
        bootcInput(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        "runtime update mode 'signed-atomic-release-swap' is not the update path of host model 'bootc-image'",
      );
    });

    // The extras case. The pre-P-306 validator required every EXPECTED check and never rejected
    // an unexpected one, so this exact document — a bootc host also reporting that it verified a
    // minisign bundle signature — would have validated clean.
    it('refuses a bootc attestation that also carries the bundle checks', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        bootcAttestation({
          checks: [
            ...workspaceHostBootstrapChecks('bootc-image'),
            'bundle-digest' as const,
            'bundle-signature' as const,
          ].map((name) => ({ name, ok: true as const })),
        }),
        bootcInput(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        "bootstrap attestation carries checks that host model 'bootc-image' cannot establish: bundle-digest, bundle-signature",
      );
    });

    it('refuses a bootc attestation reporting a minisign trust chain', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        bootcAttestation({
          release: {
            ...bootcAttestation().release,
            bundleSha256: 'a'.repeat(64),
          } as unknown as BootcAttestation['release'],
        }),
        bootcInput(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        'bootc attestation reports a minisign bundle trust chain it cannot have performed',
      );
    });

    it('refuses an attestation whose model does not match the render', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        attestation(),
        bootcInput(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        "attested host model 'ubuntu-release-bundle' does not match the rendered model 'bootc-image'",
      );
    });

    it('refuses a tag-only digest match', () => {
      const verdict = validateWorkspaceHostBootstrapAttestation(
        bootcAttestation({
          release: {
            ...bootcAttestation().release,
            imageDigest: `sha256:${'c'.repeat(64)}`,
          },
        }),
        bootcInput(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        'attested image digest does not match the pinned release image',
      );
    });

    // WI-10006339: a correct host boots `repo@digest` (the bake and the bootstrap both pin the
    // digest), so the attested ref is checked against that, never against the tag ref.
    it('accepts the digest-pinned booted ref on a registry with a port, refuses the tag ref and another repository', () => {
      const input = bootcInput({
        bootc: {
          ...bootcInput().bootc!,
          image: '127.0.0.1:5096/papercusp/workspace-host:papercusp-workspace-host-aws-a-r62b',
        },
      });
      const digest = input.bootc!.imageDigest;
      const withSource = (source: string) =>
        validateWorkspaceHostBootstrapAttestation(
          bootcAttestation({ release: { ...bootcAttestation().release, source } }),
          input,
        );
      expect(workspaceHostBootcPinnedImageRef(input.bootc!)).toBe(
        `127.0.0.1:5096/papercusp/workspace-host@${digest}`,
      );
      expect(withSource(`127.0.0.1:5096/papercusp/workspace-host@${digest}`).ok).toBe(true);
      for (const source of [
        input.bootc!.image,
        `127.0.0.1:5096/papercusp/other-host@${digest}`,
        `127.0.0.1@${digest}`,
      ]) {
        const verdict = withSource(source);
        expect(verdict.ok, source).toBe(false);
        expect(verdict.errors).toContain(
          'attested booted image ref does not match the pinned release image',
        );
      }
    });

    // Both directions. The second is the quiet one: a caller who passes a bootc block on an
    // ubuntu render believes it pinned an image, and nothing in that script reads it.
    it('requires a bootc descriptor for the bootc model', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(bootcInput({ bootc: undefined })),
      ).toThrow("hostModel 'bootc-image' requires a bootc release descriptor");
    });

    it('refuses a bootc descriptor on the bundle model', () => {
      expect(() =>
        buildWorkspaceHostBootstrap({
          ...input(),
          bootc: bootcInput().bootc,
        }),
      ).toThrow(
        "bootc release descriptor is only valid with hostModel 'bootc-image'",
      );
    });

    // Registry-qualified, because an unqualified ref is resolved by the HOST's search registries
    // rather than by us — the pulled image would be chosen by host configuration.
    it('refuses an unqualified image reference', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(
          bootcInput({
            bootc: {
              ...bootcInput().bootc!,
              image: 'workspace-host:2026.9.4-1',
            },
          }),
        ),
      ).toThrow('bootc.image must be a registry-qualified image reference');
    });

    // D-286. The failure this refuses is the one that LOOKS like success: a real, well-formed
    // `sigstoreSigned` policy sitting at a path the pull never reads. Every check the render
    // performs passes over it — the file exists, jq finds the entry — and the attestation says
    // `signatureVerified: true`, while bootc admitted the image under the base's permissive
    // `/etc/containers/policy.json`. Measured with paired controls (probes D-F): replacing that
    // one file flips an identical unsigned copy from exit 0 to "rejected by policy", and a valid
    // permissive policy at any other path changes nothing.
    it('refuses a signature policy at any path other than the one a pull consults', () => {
      expect(WORKSPACE_HOST_CONTAINERS_POLICY_PATH).toBe(
        '/etc/containers/policy.json',
      );
      for (const path of [
        // The most plausible wrong answer: our own artifact's name, in a papercusp-owned
        // directory. It is absolute, it is real, and it gates nothing.
        '/usr/lib/papercusp/release-signature-policy.json',
        '/etc/containers/policy.json.d/papercusp.json',
        '/etc/pki/papercusp/policy.json',
      ]) {
        expect(() =>
          buildWorkspaceHostBootstrap(
            bootcInput({
              bootc: { ...bootcInput().bootc!, signaturePolicyPath: path },
            }),
          ),
        ).toThrow('the only policy a bootc pull consults');
      }
    });

    // The positive control for the refusal above: absoluteness alone was the OLD bar, so a test
    // that only proved rejection would also pass against a render that refused everything.
    it('accepts the policy path a pull actually consults, and attests it', () => {
      const script = buildWorkspaceHostBootstrap(
        bootcInput({
          bootc: {
            ...bootcInput().bootc!,
            signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
          },
        }),
      );
      expect(script).toContain(WORKSPACE_HOST_CONTAINERS_POLICY_PATH);
      expect(script).toContain('signaturePolicyPath');
    });

    it('refuses a digest that is not a pinned sha256 manifest digest', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(
          bootcInput({
            bootc: { ...bootcInput().bootc!, imageDigest: 'latest' },
          }),
        ),
      ).toThrow('bootc.imageDigest must be');
    });

    // The default is the model the whole fleet runs today; an omitted field must not silently
    // move a host onto the unported path.
    it('defaults an unspecified host model to the shipped bundle model', () => {
      expect(buildWorkspaceHostBootstrap(input())).toContain(
        'signed-atomic-release-swap',
      );
      expect(
        validateWorkspaceHostBootstrapAttestation(attestation(), input()).ok,
      ).toBe(true);
    });
  });
});

describe('hosted connector enrollment conduit (D-403)', () => {
  const ORIGIN = 'https://app.papercusp.com';
  const TICKET = `ht_${'A'.repeat(43)}`;
  const BEARER = `hc_${'b'.repeat(43)}`;
  const connectorInput = () => input({ hostedConnector: { controlPlaneOrigin: ORIGIN } });

  it('renders nothing new when no control-plane origin is configured', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain(WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT);
    expect(script).not.toContain(WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM);
    expect(script).not.toContain('EnvironmentFile=');
    expect(script).toContain(
      '$WORKSPACE_USER ALL=(root) NOPASSWD: PAPERCUSP_WORKSPACE_HOST_INITIALIZER, PAPERCUSP_WORKSPACE_HOST_DELIVERY\n',
    );
  });

  it('grants the program with its exact argv only, and reads the bearer through an optional root file', () => {
    const script = buildWorkspaceHostBootstrap(connectorInput());
    expect(script).toContain(
      `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_CONNECTOR = ${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM} ${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV.join(' ')}`,
    );
    expect(script).toContain('Defaults!PAPERCUSP_WORKSPACE_HOST_CONNECTOR env_reset, !setenv');
    expect(script).toContain(
      'NOPASSWD: PAPERCUSP_WORKSPACE_HOST_INITIALIZER, PAPERCUSP_WORKSPACE_HOST_DELIVERY, PAPERCUSP_WORKSPACE_HOST_CONNECTOR\n',
    );
    expect(script).toContain(`EnvironmentFile=-${WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE}`);
    expect(script).toContain(
      `exec /usr/bin/sudo -n -- '${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM}' "$@"`,
    );
    // The same region the sibling conduit test polices: still one grant line, still no wildcard.
    const region = script.slice(
      script.indexOf('install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"'),
      script.indexOf('cat > "/etc/systemd/system/$SERVICE_NAME.service"'),
    );
    expect(region.match(/NOPASSWD:/g)).toHaveLength(1);
    expect(region).not.toMatch(/ALL=\(ALL|NOPASSWD:\s*ALL|\*|\beval\b|\bsh -c\b/);
    expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
  });

  it('refuses an origin that is not a bare HTTPS origin', () => {
    for (const controlPlaneOrigin of [
      'http://app.papercusp.com',
      'https://app.papercusp.com/api',
      'https://app.papercusp.com?x=1',
      'https://user:pw@app.papercusp.com',
    ]) {
      expect(() => buildWorkspaceHostBootstrap(input({ hostedConnector: { controlPlaneOrigin } }))).toThrow(
        /hostedConnector\.controlPlaneOrigin/,
      );
    }
  });

  /**
   * Materialize the root program exactly as the bootstrap writes it on a host (the same heredocs,
   * run by bash with the bootstrap's own variables), then run it under `sh` with a fake curl and a
   * fake systemctl on PATH. Only the root-only file path is redirected into the sandbox.
   */
  function materialize(status: string, body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'connector-enroll-'));
    const script = buildWorkspaceHostBootstrap(connectorInput());
    const start = script.indexOf('cat > "$CONNECTOR_ENROLLMENT_PROGRAM" <<PAPERCUSP_CONNECTOR_PROGRAM_HEADER');
    const endMarker = '\nPAPERCUSP_CONNECTOR_PROGRAM\n';
    const end = script.indexOf(endMarker, start) + endMarker.length;
    const program = join(dir, 'program');
    const writer = spawnSync('bash', ['-c', script.slice(start, end)], {
      env: { CONNECTOR_ENROLLMENT_PROGRAM: program, WORKSPACE_ROOT: '/srv/papercusp/workspaces', SERVICE_NAME: 'papercusp-workspace' },
      encoding: 'utf8',
    });
    expect(writer.status, writer.stderr).toBe(0);
    const envFile = join(dir, 'hosted-connector.env');
    const text = readFileSync(program, 'utf8');
    expect(text).toContain(`ENVIRONMENT_FILE='${WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE}'`);
    writeFileSync(program, text.replace(`ENVIRONMENT_FILE='${WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE}'`, `ENVIRONMENT_FILE='${envFile}'`));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${dir}/curl.argv'`,
      `cat > '${dir}/curl.config'`,
      'while [ "$#" -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done',
      `printf '%s' '${body}' > "$out"`,
      `printf '%s' '${status}'`,
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${dir}/systemctl.args'\n`, { mode: 0o755 });
    const run = (stdin: string) => spawnSync('sh', [program, ...WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV], {
      input: stdin,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    return { dir, envFile, run };
  }

  it('redeems the ticket without putting it in argv, writes a root-only bearer file, and restarts the service', () => {
    const response = `{"ok":true,"binding":{"hostId":"host-1","generation":3,"state":"active"},"bearer":"${BEARER}"}`;
    const { dir, envFile, run } = materialize('200', response);
    try {
      const result = run(`${TICKET}\n`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV[1],
        generation: 3,
        registered: true,
      });
      expect(result.stdout).not.toContain(BEARER);
      expect(readFileSync(envFile, 'utf8')).toBe(
        `PAPERCUSP_HOSTED_CONNECTOR_BEARER=${BEARER}\nPAPERCUSP_HOSTED_CONTROL_PLANE_URL=${ORIGIN}\nPAPERCUSP_HOSTED_WORKSPACE_ROOT=/srv/papercusp/workspaces\n`,
      );
      expect(spawnSync('stat', ['-c', '%a', envFile], { encoding: 'utf8' }).stdout.trim()).toBe('600');
      const argv = readFileSync(join(dir, 'curl.argv'), 'utf8');
      expect(argv).not.toContain(TICKET);
      expect(argv).toContain(`${ORIGIN}/api/hosted/connectors/register`);
      expect(argv).toContain('=https');
      expect(readFileSync(join(dir, 'curl.config'), 'utf8')).toBe(`header = "x-papercusp-connector-ticket: ${TICKET}"\n`);
      expect(readFileSync(join(dir, 'systemctl.args'), 'utf8')).toBe('restart papercusp-workspace.service\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed ticket before any request is made', () => {
    const { dir, envFile, run } = materialize('200', '{}');
    try {
      for (const bad of [`${TICKET}x`, `hc_${'A'.repeat(43)}`, `ht_${'A'.repeat(42)};`, '']) {
        const result = run(`${bad}\n`);
        expect(result.status).toBe(65);
      }
      expect(existsSync(join(dir, 'curl.argv'))).toBe(false);
      expect(existsSync(envFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing and restarts nothing when the control plane refuses the ticket', () => {
    const { dir, envFile, run } = materialize('401', '{"ok":false,"error":{"code":"connector_ticket_invalid"}}');
    try {
      const result = run(`${TICKET}\n`);
      expect(result.status).toBe(77);
      expect(result.stderr).toContain('HTTP 401');
      expect(existsSync(envFile)).toBe(false);
      expect(existsSync(join(dir, 'systemctl.args'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// WI-6554700010012418 (owner directive #1879): compressed-RAM swap on the Ubuntu cloud desktops.
// The function's behaviour is tested in zram-swap.test.ts; these pin where, for which model, and
// how failure-tolerant it renders.
describe('zram swap (WI-6554700010012418)', () => {
  const render = (hostModel: (typeof WORKSPACE_HOST_MODELS)[number]) =>
    buildWorkspaceHostBootstrap(hostModel === 'bootc-image' ? bootcInput() : input());
  const zramCall = `  ${ZRAM_SWAP_FUNCTION} /etc/systemd/zram-generator.conf /etc/sysctl.d/90-papercusp-zram.conf /usr/lib/systemd/system-generators/zram-generator /proc/swaps`;
  const zramInstall = `if retry 3 apt_install -y --no-install-recommends ${ZRAM_GENERATOR_APT_PACKAGE} >/dev/null; then`;

  it('installs the generator and configures zram on Ubuntu, after the runtime packages', () => {
    const ubuntu = render('ubuntu-release-bundle');
    const runtime = ubuntu.indexOf('retry 5 apt_install -y --no-install-recommends ');
    const install = ubuntu.indexOf(zramInstall);
    const call = ubuntu.indexOf(`\n${zramCall}\n`);
    expect(runtime).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(runtime);
    expect(call).toBeGreaterThan(install);
    // The function is defined before the call that uses it.
    expect(ubuntu.indexOf(`\n${ZRAM_SWAP_FUNCTION}() {\n`)).toBeGreaterThan(-1);
    expect(ubuntu.indexOf(`\n${ZRAM_SWAP_FUNCTION}() {\n`)).toBeLessThan(call);
  });

  it('never dies on zram: a failed package fetch reports and the bootstrap continues', () => {
    const ubuntu = render('ubuntu-release-bundle');
    const block = ubuntu.slice(ubuntu.indexOf(zramInstall), ubuntu.indexOf('\nfi\n', ubuntu.indexOf(zramInstall)) + 4);
    expect(block).toContain('PAPERCUSP_ZRAM_SWAP status=absent reason=package-install-failed');
    expect(block).not.toContain('die ');
  });

  it('stays out of the required apt contract, which dies on a failed fetch', () => {
    expect(WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES).not.toContain(ZRAM_GENERATOR_APT_PACKAGE);
  });

  it('does not render on the bootc image (no apt there)', () => {
    const bootc = render('bootc-image');
    expect(bootc).not.toContain(ZRAM_SWAP_FUNCTION);
    expect(bootc).not.toContain(ZRAM_GENERATOR_APT_PACKAGE);
  });

  it('renders a script bash can parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zram-bootstrap-'));
    try {
      const file = join(dir, 'bootstrap.sh');
      writeFileSync(file, render('ubuntu-release-bundle'));
      const parsed = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(parsed.stderr).toBe('');
      expect(parsed.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// WI-10004636: Codex's workspace-write sandbox runs every tool command through bwrap. On stock
// Ubuntu 24.04 an unprivileged bwrap cannot get a usable user namespace without an AppArmor grant,
// and the failure is SILENT (every command fails, the run reports success). The grant behaviour
// itself is tested in bwrap-userns-grant.test.ts; these pin where and for which model it renders.
describe('agent sandbox user namespaces (WI-10004636)', () => {
  const render = (hostModel: (typeof WORKSPACE_HOST_MODELS)[number]) =>
    buildWorkspaceHostBootstrap(hostModel === 'bootc-image' ? bootcInput() : input());
  const grantCall = `${BWRAP_USERNS_GRANT_FUNCTION} /etc/apparmor.d `;

  it('installs bubblewrap through the Ubuntu apt contract', () => {
    expect(WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES).toContain('bubblewrap');
  });

  it('renders the AppArmor grant on Ubuntu only, after the package install', () => {
    const ubuntu = render('ubuntu-release-bundle');
    const install = ubuntu.indexOf('retry 5 apt_install -y --no-install-recommends ');
    const call = ubuntu.indexOf(grantCall);
    expect(install).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(install);
    // CentOS Stream 9 has no AppArmor; rendering the grant there would only be dead code.
    expect(render('bootc-image')).not.toContain(grantCall);
  });

  it.each(WORKSPACE_HOST_MODELS)('probes as the agent account after it exists, and dies loudly (%s)', (hostModel) => {
    const script = render(hostModel);
    const created = script.indexOf('useradd --system --gid "$AGENT_GROUP"');
    const probe = script.indexOf('runuser -u "$AGENT_USER" -- /usr/bin/bwrap ');
    expect(created).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(created);
    const line = script.slice(probe, script.indexOf('\n', probe));
    expect(line).toContain('--unshare-user --unshare-pid --unshare-net');
    expect(line).toContain('|| die "agent sandbox cannot create a user namespace');
    if (hostModel === 'ubuntu-release-bundle') expect(script.indexOf(grantCall)).toBeLessThan(probe);
  });

  it('attests agent-sandbox-userns on both host models', () => {
    for (const hostModel of WORKSPACE_HOST_MODELS) {
      expect(workspaceHostBootstrapChecks(hostModel)).toContain('agent-sandbox-userns');
    }
  });

  // The probe's die guard has to work as shell, not just as text: a failing bwrap must stop the
  // script with the bwrap error in the message, and a passing one must let it continue.
  it.each([
    ['fails', 'echo "loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1', 1],
    ['passes', 'exit 0', 0],
  ] as const)('the rendered probe line stops the script when bwrap %s', (_label, body, wantStatus) => {
    const script = render('ubuntu-release-bundle');
    const start = script.indexOf('sandbox_probe_err=');
    const line = script.slice(start, script.indexOf('\n', start));
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-probe-'));
    try {
      // Stands in for `runuser -u <agent> -- bwrap …`; only its exit status and stderr matter.
      writeFileSync(join(dir, 'runuser'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            'die() { echo "ERROR: $1" >&2; exit 1; }',
            'AGENT_USER=papercusp-agent',
            line,
            'echo CONTINUED',
          ].join('\n'),
        ],
        { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
      );
      expect(result.status).toBe(wantStatus);
      if (wantStatus === 1) {
        expect(result.stderr).toContain('agent sandbox cannot create a user namespace as papercusp-agent');
        expect(result.stderr).toContain('RTM_NEWADDR');
        expect(result.stdout).not.toContain('CONTINUED');
      } else {
        expect(result.stdout).toContain('CONTINUED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WI-10006965: the bootstrap runs under `set -u`, so a variable it EXPANDS but never ASSIGNS
 * aborts it at that line. A bootc host died in install-runtime on `$WORK_DIR` (and would have
 * died on `$PREVIOUS_TARGET` after its first reboot) because only the bundle arm assigned them,
 * while code after the model branch read them on both models. Every host model x action is
 * rendered with every agent, and each bare UPPERCASE expansion must have an assignment in the
 * script. Defaulted expansions (`${X:-}`, `${X-}`, `${X:+}`, `${X:=}`) are `set -u` safe.
 */
describe('rendered bootstrap assigns every variable it expands (WI-10006965)', () => {
  // Assigned outside the script text: by bash itself, or by `. /etc/os-release`.
  const ASSIGNED_OUTSIDE_SCRIPT = new Set(['BASH_COMMAND', 'EUID', 'SECONDS', 'VERSION_ID']);

  function unassignedExpansions(script: string): { unassigned: string[]; expansions: number } {
    const assigned = new Set<string>(ASSIGNED_OUTSIDE_SCRIPT);
    for (const m of script.matchAll(/\b([A-Z_][A-Z0-9_]*)(?:\[[^\]]*\])?\+?=/g)) assigned.add(m[1]);
    for (const m of script.matchAll(
      /\b(?:for|local|export|declare|readonly|read(?:\s+-\w+)*)\s+((?:[A-Z_][A-Z0-9_]*\s*)+)/g,
    )) {
      for (const name of m[1].trim().split(/\s+/)) assigned.add(name);
    }
    const unassigned = new Set<string>();
    let expansions = 0;
    for (const m of script.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)(:?[-=+?])?/g)) {
      if (m[2] && m[2] !== ':?' && m[2] !== '?') continue;
      expansions += 1;
      if (!assigned.has(m[1])) unassigned.add(m[1]);
    }
    return { unassigned: [...unassigned].sort(), expansions };
  }

  it('flags an expansion nothing assigns, and accepts assigned and defaulted ones (control)', () => {
    expect(unassignedExpansions('set -u\nA=1\necho "$A ${B} ${C:-x} $EUID"').unassigned).toEqual(['B']);
  });

  for (const [model, render] of [
    ['ubuntu-release-bundle', input],
    ['bootc-image', bootcInput],
  ] as const) {
    for (const action of ['install', 'upgrade', 'rollback'] as const) {
      it(`${model} ${action} with every agent`, () => {
        const script = buildWorkspaceHostBootstrap(
          render({ action, agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
        );
        const { unassigned, expansions } = unassignedExpansions(script);
        // The scan must actually have walked the script, or an empty list proves nothing.
        expect(expansions).toBeGreaterThan(200);
        expect(unassigned).toEqual([]);
      });
    }
  }

  it('the bootc local-inference install reads a WORK_DIR assigned before it', () => {
    const script = buildWorkspaceHostBootstrap(
      bootcInput({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const assignedAt = script.indexOf('WORK_DIR="$(mktemp -d');
    const usedAt = script.indexOf('OLLAMA_TMP="$WORK_DIR/');
    expect(usedAt).toBeGreaterThan(-1);
    expect(assignedAt).toBeGreaterThan(-1);
    expect(assignedAt).toBeLessThan(usedAt);
  });
});

/**
 * WI-10006974: on a bootc image /home is a symlink to var/home, so `readlink -f` of the
 * installer's ~/.local/bin/claude symlink yields /var/home/<agent>/... A prefix test of that
 * CANONICAL path against the raw $AGENT_HOME (/home/<agent>) refused a correctly installed CLI
 * and killed install-runtime. The rendered check is executed against three fixture layouts: a
 * symlinked home (bootc), a plain home (Ubuntu), and a CLI that resolves outside the home, which
 * must still be refused.
 */
describe('vendor claude resolve check survives a symlinked /home (WI-10006974)', () => {
  function renderedClaudeCheck(): string {
    const script = buildWorkspaceHostBootstrap(
      bootcInput({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const start = script.indexOf('CLAUDE_REAL="$(readlink -f');
    const dieAt = script.indexOf('die "vendor claude did not resolve to a file inside the agent home"', start);
    expect(start).toBeGreaterThan(-1);
    expect(dieAt).toBeGreaterThan(start);
    return script.slice(start, script.indexOf('\n', dieAt));
  }

  function runCheck(layout: 'symlinked-home' | 'plain-home' | 'outside-home') {
    const root = mkdtempSync(join(tmpdir(), 'wi10006974-'));
    try {
      const realHomes = layout === 'plain-home' ? join(root, 'home') : join(root, 'var', 'home');
      mkdirSync(realHomes, { recursive: true });
      if (layout !== 'plain-home') symlinkSync(join('var', 'home'), join(root, 'home'));
      const agentHome = join(root, 'home', 'agent');
      const versions = join(realHomes, 'agent', '.local', 'share', 'claude', 'versions');
      mkdirSync(versions, { recursive: true });
      mkdirSync(join(realHomes, 'agent', '.local', 'bin'), { recursive: true });
      writeFileSync(join(versions, '9.9.9'), '#!/bin/sh\n');
      const outside = join(root, 'opt-claude');
      writeFileSync(outside, '#!/bin/sh\n');
      const target = layout === 'outside-home' ? outside : join('..', 'share', 'claude', 'versions', '9.9.9');
      symlinkSync(target, join(realHomes, 'agent', '.local', 'bin', 'claude'));
      return spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'die() { echo "DIE: $*" >&2; exit 3; }',
        renderedClaudeCheck(),
        'echo "OK $CLAUDE_REAL"',
      ].join('\n')], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          AGENT_HOME: agentHome,
          AGENT_RUNTIME_CLAUDE: join(agentHome, '.local', 'bin', 'claude'),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts a CLI installed under a symlinked home (bootc /home -> var/home)', () => {
    const run = runCheck('symlinked-home');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/OK .*\/var\/home\/agent\/\.local\/share\/claude\/versions\/9\.9\.9/);
  });

  it('accepts a CLI installed under a plain home (Ubuntu)', () => {
    const run = runCheck('plain-home');
    expect(run.status, run.stderr).toBe(0);
  });

  it('still refuses a CLI that resolves outside the agent home (control)', () => {
    const run = runCheck('outside-home');
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('vendor claude did not resolve to a file inside the agent home');
  });
});
