import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point the suite at a copy outside the tree.
const SCRIPT = process.env.RELEASE_SUPPLY_CHAIN_SCRIPT ?? join(ROOT, 'infra/images/bootc/release-supply-chain.sh');
const DIGEST = 'sha256:' + '1'.repeat(64);

const genericKernelCpe = {
  artifact: { name: 'kernel-core', type: 'rpm', version: '5.14.0-730.el9' },
  vulnerability: {
    id: 'CVE-2024-1086',
    namespace: 'nvd:cpe',
    severity: 'High',
    fix: { state: 'fixed', versions: ['5.15.149'] },
  },
};

// The REAL shape syft + grype emit for the kernel image itself on a bootc image (measured on the
// P-012 AWS bake, WI-10005674): syft's linux-kernel cataloger reads vmlinuz, so the artifact is
// type `linux-kernel` with a pkg:generic purl — not an rpm — while the RPMs stay vendor-matched.
const genericKernelImageCpe = {
  artifact: {
    name: 'linux-kernel',
    type: 'linux-kernel',
    version: '5.14.0-730.el9.x86_64',
    purl: 'pkg:generic/linux-kernel@5.14.0-730.el9.x86_64',
    locations: [{ path: '/usr/lib/modules/5.14.0-730.el9.x86_64/vmlinuz' }],
  },
  vulnerability: {
    id: 'CVE-2022-0185',
    namespace: 'nvd:cpe',
    severity: 'High',
    fix: { state: 'fixed', versions: ['5.4.173', '5.10.93', '5.15.16', '5.16.2'] },
  },
};

const vendorKernelFinding = {
  artifact: { name: 'kernel-core', type: 'rpm', version: '5.14.0-730.el9' },
  vulnerability: {
    id: 'RHSA-2026:1234',
    namespace: 'redhat:distro',
    severity: 'High',
    fix: { state: 'fixed', versions: ['5.14.0-731.el9'] },
  },
};

const nonKernelNvdFinding = {
  artifact: { name: 'openssl-libs', type: 'rpm', version: '3.0.7-30.el9' },
  vulnerability: {
    id: 'CVE-2026-9999',
    namespace: 'nvd:cpe',
    severity: 'Critical',
    fix: { state: 'fixed', versions: ['3.0.7-31.el9'] },
  },
};

const tempDirs: string[] = [];

interface GateOptions {
  secretScanExit?: number;
  /** syft-json written in place of the default 50 empty artifacts (D-027 RPM ownership). */
  sbom?: { artifacts: unknown[] };
  /** stdout of the in-image `dnf check-update` container (D-027 vendor check). */
  vendorCheckOutput?: string;
  vendorCheckExit?: number;
  /** WI-10006045: stdout of a SECOND probe container (the retry after an incomplete probe). */
  vendorCheckRetryOutput?: string;
  /**
   * WI-10006045: run a COPY of the script from a directory that is not a git checkout, the way
   * the bake runs it from its build-context snapshot.
   */
  outsideCheckout?: boolean;
  extraArgs?: string[];
}

function runGate(matches: unknown[], opts: GateOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-supply-chain-gate-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const key = join(dir, 'release.key');
  const pubkey = join(dir, 'release.pub');
  const fixture = join(dir, 'vulns.json');
  mkdirSync(bin);
  mkdirSync(out);
  writeFileSync(key, 'fixture key\n');
  writeFileSync(pubkey, 'fixture pubkey\n');
  writeFileSync(fixture, JSON.stringify({ matches }));
  const sbomFixture = join(dir, 'sbom.syft.json');
  if (opts.sbom) writeFileSync(sbomFixture, JSON.stringify(opts.sbom));

  writeFileSync(
    join(bin, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '[ "\${1:-}" = "-n" ] && shift',
      'exec "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'podman'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$*" >> "$PODMAN_CALL_LOG"',
      'if [[ " $* " == *" skopeo "* ]]; then',
      "  printf '%s\\n' '__DIGEST__'",
      '  exit 0',
      'fi',
      'if [[ " $* " == *"check-update"* ]]; then',
      '  if [ -n "${PODMAN_VENDOR_CHECK_OUTPUT_RETRY:-}" ] && [ -f "$PODMAN_CALL_LOG.probed" ]; then',
      '    printf "%s" "$PODMAN_VENDOR_CHECK_OUTPUT_RETRY"; exit 0',
      '  fi',
      '  : > "$PODMAN_CALL_LOG.probed"',
      '  printf "%s" "$PODMAN_VENDOR_CHECK_OUTPUT"',
      '  exit "$PODMAN_VENDOR_CHECK_EXIT"',
      'fi',
      'exit 0',
      '',
    ].join('\n').replace('__DIGEST__', DIGEST),
    { mode: 0o755 },
  );
  const podmanCallLog = join(dir, 'podman-calls.log');
  writeFileSync(podmanCallLog, '');
  writeFileSync(
    join(bin, 'secret-scan'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "secret-scan %s\\n" "$*" >> "$PODMAN_CALL_LOG"',
      'exit "$SECRET_SCAN_EXIT"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'syft'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'write_sbom() {',
      '  out="\${1#*=}"',
      '  if [ -n "\${SYFT_FIXTURE:-}" ]; then cp "$SYFT_FIXTURE" "$out"; return; fi',
      `  printf '%s' '{"artifacts":[{}' > "$out"`,
      '  for _ in $(seq 1 49); do printf ",{}" >> "$out"; done',
      `  printf '%s\\n' ']}' >> "$out"`,
      '}',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    spdx-json=*) write_sbom "$arg" ;;',
      '    syft-json=*) write_sbom "$arg" ;;',
      '  esac',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'grype'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "\${1:-}" = "db" ] && [ "\${2:-}" = "status" ]; then',
      "  printf 'Status: valid\\n'",
      'else',
      '  cat "$GRYPE_FIXTURE"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  let script = SCRIPT;
  if (opts.outsideCheckout) {
    const snapshot = join(dir, 'snapshot');
    mkdirSync(snapshot);
    script = join(snapshot, 'release-supply-chain.sh');
    writeFileSync(script, readFileSync(SCRIPT, 'utf8'), { mode: 0o755 });
  }

  const result = spawnSync(
    'bash',
    [
      script,
      ...(opts.extraArgs ?? []),
      '--image',
      'registry.example.com/papercusp/workspace-host:fixture',
      '--key',
      key,
      '--pubkey',
      pubkey,
      '--out',
      out,
      '--fail-on-vulns',
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: bin + ':' + (process.env.PATH ?? ''),
        PODMAN_CALL_LOG: podmanCallLog,
        GRYPE_FIXTURE: fixture,
        SYFT_BIN: join(bin, 'syft'),
        GRYPE_BIN: join(bin, 'grype'),
        // The real scanner exports the image rootfs through `sudo -n podman`; the stub records
        // its argv in the same call log so ordering against cosign is observable.
        SECRET_SCAN_BIN: join(bin, 'secret-scan'),
        SECRET_SCAN_EXIT: String(opts.secretScanExit ?? 0),
        SYFT_FIXTURE: opts.sbom ? sbomFixture : '',
        PODMAN_VENDOR_CHECK_OUTPUT: opts.vendorCheckOutput ?? '',
        PODMAN_VENDOR_CHECK_EXIT: String(opts.vendorCheckExit ?? 0),
        PODMAN_VENDOR_CHECK_OUTPUT_RETRY: opts.vendorCheckRetryOutput ?? '',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  return {
    status: result.status ?? -1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    podmanCalls: readFileSync(podmanCallLog, 'utf8').split('\n').filter(Boolean),
    out,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('release supply-chain cosign container identity (WI-10005606)', () => {
  it('runs every cosign container as the caller uid:gid, so a 0600 release key stays readable', () => {
    // The cosign image defaults to uid 65532, which cannot open a 0600 key owned by the
    // caller. Measured 2026-10-02: signing died with "open /keys/cosign.key: permission
    // denied" after a full image build.
    const result = runGate([]);
    expect(result.status, result.output).toBe(0);
    const cosignCalls = result.podmanCalls.filter((call) => call.includes('/keys:') || call.includes('/keys '));
    const signAndVerify = result.podmanCalls.filter((call) => / (sign|attest|verify|verify-attestation) /.test(call));
    expect(signAndVerify.length).toBeGreaterThanOrEqual(4);
    const expectedUser = `--user ${process.getuid!()}:${process.getgid!()}`;
    for (const call of [...cosignCalls, ...signAndVerify]) {
      expect(call).toContain(expectedUser);
      expect(call).toContain('-e HOME=/tmp');
    }
  });
});

describe('release supply-chain provenance source commit (WI-10006045)', () => {
  const provenance = (out: string) =>
    JSON.parse(readFileSync(join(out, 'provenance.json'), 'utf8')) as {
      buildDefinition: { internalParameters: { sourceCheckout: string } };
    };
  const COMMIT = 'a'.repeat(40);

  it('records the commit it is handed when it runs outside a git checkout', () => {
    const result = runGate([], { outsideCheckout: true, extraArgs: ['--source-commit', COMMIT] });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`SOURCE_COMMIT=${COMMIT}`);
    expect(provenance(result.out).buildDefinition.internalParameters.sourceCheckout).toBe(COMMIT);
  });

  it('refuses before scanning or signing when it has no commit, instead of recording "unknown"', () => {
    // Measured 2026-10-03: the bake ran this script from its snapshot, wrote sourceCheckout
    // 'unknown', and the release trust gate refused the image only after the whole bake.
    const result = runGate([], { outsideCheckout: true });
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('no source commit for the provenance');
    expect(result.podmanCalls).toEqual([]);
    expect(existsSync(join(result.out, 'provenance.json'))).toBe(false);
  });

  it('refuses a malformed --source-commit the same way', () => {
    const result = runGate([], { outsideCheckout: true, extraArgs: ['--source-commit', 'unknown'] });
    expect(result.status, result.output).toBe(2);
    expect(result.podmanCalls).toEqual([]);
  });

  it('records "unpinned" for an explicitly unpinned source', () => {
    const result = runGate([], { outsideCheckout: true, extraArgs: ['--allow-unpinned-source'] });
    expect(result.status, result.output).toBe(0);
    expect(provenance(result.out).buildDefinition.internalParameters.sourceCheckout).toBe('unpinned');
  });

  it('reads the commit from the checkout it lives in when run in place', () => {
    const result = runGate([]);
    expect(result.status, result.output).toBe(0);
    expect(provenance(result.out).buildDefinition.internalParameters.sourceCheckout).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('portable OCI producer provenance (P-058)', () => {
  it('attests the Server producer and runtime instead of the default bootc image', () => {
    const result = runGate([], { extraArgs: [
      '--source-commit', 'a'.repeat(40), '--containerfile', 'infra/images/server/Containerfile',
      '--build-type', 'https://papercusp.dev/server/container/v1',
      '--builder-id', 'https://papercusp.dev/builders/server-container', '--base-image', 'ubuntu:24.04',
    ] });
    expect(result.status, result.output).toBe(0);
    const predicate = JSON.parse(readFileSync(join(result.out, 'provenance.json'), 'utf8'));
    expect(predicate.buildDefinition).toMatchObject({
      buildType: 'https://papercusp.dev/server/container/v1',
      externalParameters: { containerfile: 'infra/images/server/Containerfile', baseImage: 'ubuntu:24.04' },
      internalParameters: { sourceCheckout: 'a'.repeat(40) },
      resolvedDependencies: [{ uri: 'ubuntu:24.04' }],
    });
    expect(predicate.runDetails.builder.id).toBe('https://papercusp.dev/builders/server-container');
    expect(result.podmanCalls.some(call => call.includes('verify-attestation'))).toBe(true);
  });

  it('refuses an invalid producer identity before a signing call', () => {
    for (const args of [
      ['--containerfile', '../other/Containerfile'],
      ['--build-type', 'unknown'],
      ['--builder-id', 'http://untrusted.example/builder'],
    ]) {
      const result = runGate([], { extraArgs: args });
      expect(result.status, result.output).toBe(2);
      expect(result.podmanCalls).toEqual([]);
    }
  });

  it('encodes provenance parameters as JSON without interpolation', () => {
    const base = 'registry.example/base:quote"slash\\tail';
    const result = runGate([], { extraArgs: ['--base-image', base] });
    expect(result.status, result.output).toBe(0);
    const predicate = JSON.parse(readFileSync(join(result.out, 'provenance.json'), 'utf8'));
    expect(predicate.buildDefinition.externalParameters.baseImage).toBe(base);
  });
});

describe('release supply-chain secret scan runs before signing (WI-10005624)', () => {
  const isSigningCall = (call: string) => / (sign|attest) /.test(call);
  const scanCall = (calls: string[]) => calls.find((call) => call.startsWith('secret-scan '));

  it('scans the digest-pinned image before any cosign sign or attest call', () => {
    const result = runGate([]);
    expect(result.status, result.output).toBe(0);
    const scan = scanCall(result.podmanCalls);
    expect(scan).toBe(
      `secret-scan --image registry.example.com/papercusp/workspace-host@${DIGEST} --out ${result.out}`,
    );
    const scanAt = result.podmanCalls.indexOf(scan!);
    const firstSign = result.podmanCalls.findIndex(isSigningCall);
    expect(firstSign).toBeGreaterThan(scanAt);
    const summary = JSON.parse(readFileSync(join(result.out, 'supply-chain-summary.json'), 'utf8'));
    expect(summary.secretScan).toBe('clean');
  });

  it('exits 4 and signs nothing when the scan reports findings', () => {
    const result = runGate([], { secretScanExit: 1 });
    expect(result.status, result.output).toBe(4);
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=SECRET_FINDINGS');
    expect(scanCall(result.podmanCalls)).toBeDefined();
    expect(result.podmanCalls.filter(isSigningCall)).toEqual([]);
  });

  it('fails, and signs nothing, when the scan ends without a verdict', () => {
    const result = runGate([], { secretScanExit: 2 });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('secret scan did not complete (exit 2)');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=FAIL');
    expect(result.podmanCalls.filter(isSigningCall)).toEqual([]);
  });
});

describe('release supply-chain vulnerability gate', () => {
  it('does not fail an EL9 kernel solely on a generic upstream NVD CPE fixed version', () => {
    const result = runGate([genericKernelCpe]);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=0');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=PASS');
  });

  it('keeps vendor-confirmed kernel findings and unrelated NVD findings actionable', () => {
    const result = runGate([genericKernelCpe, vendorKernelFinding, nonKernelNvdFinding]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=2');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED');
  });

  it("excludes syft's linux-kernel artifact (vmlinuz) on an EL9 kernel exactly like the kernel RPM", () => {
    const result = runGate([genericKernelImageCpe, genericKernelCpe, vendorKernelFinding]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=2');
    // The vendor-namespace kernel finding is still the gate population.
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
  });

  it('does not apply the EL9 exception to a non-EL9 linux-kernel artifact', () => {
    const result = runGate([
      {
        ...genericKernelImageCpe,
        artifact: { ...genericKernelImageCpe.artifact, version: '6.8.0-31-generic' },
      },
    ]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=0');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
  });

  it('applies the same exception to an EL10 kernel RPM and vmlinuz artifact (D-035, WI-10005910)', () => {
    // The base moved to centos-bootc:stream10, so the kernel release is .el10 (.el10_0 on a point
    // release). Mirrors isGenericElKernelCpe in bootc-image-release-request-cli.ts.
    const result = runGate([
      { ...genericKernelCpe, artifact: { ...genericKernelCpe.artifact, version: '6.12.0-124.el10' } },
      {
        ...genericKernelImageCpe,
        artifact: { ...genericKernelImageCpe.artifact, version: '6.12.0-55.9.1.el10_0.x86_64' },
      },
    ]);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=2');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=0');
  });

  it('does not treat a release tag with no EL major (".elx") as an EL kernel', () => {
    const result = runGate([
      { ...genericKernelCpe, artifact: { ...genericKernelCpe.artifact, version: '6.12.0-124.elx' } },
    ]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=0');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
  });

  it('does not apply the EL9 exception to a non-EL9 kernel package', () => {
    const result = runGate([
      {
        ...genericKernelCpe,
        artifact: { ...genericKernelCpe.artifact, version: '6.8.0-31-generic' },
      },
    ]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=0');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED');
  });
});

// D-027 (WI-10005719). Shapes measured on the P-012 AWS bake: syft records an INSTALLED rpm at the
// rpmdb with the files it owns in metadata.files; grype reports a Go module inside an RPM-owned
// binary as a go-module located at that binary; base-layer copies sit in /sysroot/ostree objects.
const RPMDB = '/usr/share/rpm/rpmdb.sqlite';
const installedSkopeo = {
  name: 'skopeo',
  type: 'rpm',
  version: '3:1.22.2-4.el9',
  locations: [{ path: RPMDB }],
  metadata: { files: [{ path: '/usr/bin/skopeo' }, { path: '/usr/share/man/man1/skopeo.1.gz' }] },
};
// An .rpm ARCHIVE lying in the image is catalogued as type rpm too, but it is not installed: the
// files it lists are not on disk because of it, so it must never vouch for one.
const rpmArchiveOnDisk = {
  name: 'smuggled',
  type: 'rpm',
  version: '1.0-1.el9',
  locations: [{ path: '/opt/papercusp/cache/smuggled-1.0-1.el9.x86_64.rpm' }],
  metadata: { files: [{ path: '/usr/bin/smuggled' }] },
};
const vendorSbom = { artifacts: [installedSkopeo, rpmArchiveOnDisk, ...Array.from({ length: 50 }, () => ({}))] };

function goFinding(path: string, id: string) {
  return {
    artifact: { name: 'stdlib', type: 'go-module', version: 'go1.26.5', locations: [{ path }] },
    vulnerability: { id, namespace: 'govulndb:language:go', severity: 'High', fix: { state: 'fixed', versions: ['1.26.6'] } },
  };
}
const goInRpmBinary = goFinding('/usr/bin/skopeo', 'GO-2026-0001');
const goInOstreeObject = goFinding('/sysroot/ostree/repo/objects/9e/eca1cb.file', 'GO-2026-0002');
const goInPapercuspBinary = goFinding('/opt/papercusp/bin/connector', 'GO-2026-0003');
const goInArchiveClaimedPath = goFinding('/usr/bin/smuggled', 'GO-2026-0004');
const installedRpmFinding = {
  artifact: { name: 'openssl-libs', type: 'rpm', version: '1:3.5.8-1.el9', locations: [{ path: RPMDB }] },
  vulnerability: { id: 'RHSA-2026:9001', namespace: 'redhat:distro:redhat:9', severity: 'High', fix: { state: 'fixed', versions: ['1:3.5.9-1.el9'] } },
};

const NOTHING_NEWER = 'VENDOR_CHECK_UPDATE_EXIT=0\nVENDOR_ENABLED_REPOS=5\nVENDOR_AVAILABLE_PACKAGES=65756\n';

function readOut(result: ReturnType<typeof runGate>, name: string) {
  return JSON.parse(readFileSync(join(result.out, name), 'utf8'));
}

describe('release supply-chain vendor-pending classification (D-027, WI-10005719)', () => {
  it('moves only RPM-owned findings out of the gate when the image repos ship nothing newer, and lists them', () => {
    const result = runGate(
      [goInRpmBinary, installedRpmFinding, goInOstreeObject, goInPapercuspBinary, goInArchiveClaimedPath],
      { sbom: vendorSbom, vendorCheckOutput: NOTHING_NEWER },
    );

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_VENDOR_PENDING=2   (of 2 RPM-owned; vendor check: no-updates');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=3');
    const pending = readOut(result, 'vendor-pending.json') as Array<{ id: string; paths: string[] }>;
    expect(pending.map((p) => p.id).sort()).toEqual(['GO-2026-0001', 'RHSA-2026:9001']);
    const updates = readOut(result, 'vendor-updates.json');
    expect(updates).toMatchObject({ digest: DIGEST, verdict: 'no-updates', checkUpdateExit: 0, enabledRepos: 5, availablePackages: 65756 });
    const summary = readOut(result, 'supply-chain-summary.json');
    expect(summary).toMatchObject({ actionableCriticalHighWithFix: '3', vendorPending: '2', vendorCheck: 'no-updates' });
    // The question is asked of the image at the released DIGEST, not a tag.
    const check = result.podmanCalls.find((call) => call.includes('check-update'));
    expect(check).toContain(`@${DIGEST}`);
  });

  it('keeps a finding actionable when only SOME of its paths are RPM-owned (D-028)', () => {
    // One Go module found in an RPM-owned binary AND in a binary no RPM installs: the vendor can
    // only fix the first copy, so the finding must stay in the gate.
    const partlyOwned = {
      artifact: {
        name: 'stdlib',
        type: 'go-module',
        version: 'go1.26.5',
        locations: [{ path: '/usr/bin/skopeo' }, { path: '/opt/papercusp/bin/connector' }],
      },
      vulnerability: { id: 'GO-2026-0005', namespace: 'govulndb:language:go', severity: 'High', fix: { state: 'fixed', versions: ['1.26.6'] } },
    };
    const result = runGate([goInRpmBinary, partlyOwned], { sbom: vendorSbom, vendorCheckOutput: NOTHING_NEWER });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_VENDOR_PENDING=1   (of 1 RPM-owned');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    const pending = readOut(result, 'vendor-pending.json') as Array<{ id: string }>;
    expect(pending.map((p) => p.id)).toEqual(['GO-2026-0001']);
  });

  it('passes an image whose only fixed findings are vendor-pending', () => {
    const result = runGate([goInRpmBinary, installedRpmFinding], { sbom: vendorSbom, vendorCheckOutput: NOTHING_NEWER });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=0');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=PASS');
  });

  it.each([
    ['an update the vendor already ships (exit 100)', 'VENDOR_CHECK_UPDATE_EXIT=100\nVENDOR_ENABLED_REPOS=5\nVENDOR_AVAILABLE_PACKAGES=65756\n', 0, 'updates-available'],
    ['a dnf that saw no enabled repo', 'VENDOR_CHECK_UPDATE_EXIT=0\nVENDOR_ENABLED_REPOS=0\nVENDOR_AVAILABLE_PACKAGES=0\n', 0, 'error'],
    ['a dnf that read too little metadata', 'VENDOR_CHECK_UPDATE_EXIT=0\nVENDOR_ENABLED_REPOS=1\nVENDOR_AVAILABLE_PACKAGES=12\n', 0, 'error'],
    ['a dnf error (exit 1)', 'VENDOR_CHECK_UPDATE_EXIT=1\nVENDOR_ENABLED_REPOS=5\nVENDOR_AVAILABLE_PACKAGES=65756\n', 0, 'error'],
    ['a container that never ran', '', 125, 'error'],
    ['a container that failed after reporting exit 0', NOTHING_NEWER, 1, 'error'],
  ])('keeps every RPM-owned finding actionable on %s', (_label, output, exit, verdict) => {
    const result = runGate([goInRpmBinary, installedRpmFinding], { sbom: vendorSbom, vendorCheckOutput: output, vendorCheckExit: exit });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain(`GRYPE_VENDOR_PENDING=0   (of 2 RPM-owned; vendor check: ${verdict}`);
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=2');
    expect(readOut(result, 'vendor-pending.json')).toEqual([]);
    expect(readOut(result, 'vendor-updates.json').verdict).toBe(verdict);
  });

  it('does not run the image probe when no finding is RPM-owned or object-located', () => {
    const result = runGate([goInPapercuspBinary], { sbom: vendorSbom, vendorCheckOutput: NOTHING_NEWER });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('vendor check: not-needed');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    expect(result.podmanCalls.some((call) => call.includes('check-update'))).toBe(false);
  });

  // D-029. Measured on the P-012 AWS disk: object 83de1547 is /usr/bin/toolbox (live, RPM-owned),
  // the other four are old podman/skopeo copies the deployed commit never references.
  const liveObject = '/sysroot/ostree/repo/objects/83/' + 'a'.repeat(62) + '.file';
  const staleObject = '/sysroot/ostree/repo/objects/9e/' + 'b'.repeat(62) + '.file';
  const objectSbom = {
    artifacts: [
      { ...installedSkopeo, metadata: { files: [{ path: '/usr/bin/skopeo' }, { path: '/usr/bin/toolbox' }] } },
      ...Array.from({ length: 50 }, () => ({})),
    ],
  };
  const probe = (lines: string[]) => NOTHING_NEWER + lines.join('\n') + '\n';

  it('relocates a live object to its path, and lists a stale one, only on a complete probe', () => {
    const result = runGate([goFinding(liveObject, 'GO-LIVE'), goFinding(staleObject, 'GO-STALE'), goInPapercuspBinary], {
      sbom: objectSbom,
      vendorCheckOutput: probe([
        `OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`,
        `OSTREE_OBJECT_STALE ${staleObject} ${'c'.repeat(64)}`,
        'OSTREE_OBJECT_DONE',
      ]),
    });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_VENDOR_PENDING=1');
    expect(result.output).toContain('GRYPE_STALE_BASE_OBJECTS=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    expect(readOut(result, 'vendor-pending.json')[0]).toMatchObject({ id: 'GO-LIVE', livePaths: ['/usr/bin/toolbox'] });
    expect(readOut(result, 'stale-base-objects.json').map((f: { id: string }) => f.id)).toEqual(['GO-STALE']);
    expect(readOut(result, 'ostree-objects.json')).toMatchObject({ digest: DIGEST, complete: true });
    expect(readOut(result, 'supply-chain-summary.json')).toMatchObject({ staleBaseObjects: '1', vendorPending: '1' });
  });

  it.each([
    ['no end marker', [`OSTREE_OBJECT_STALE ${staleObject} ${'c'.repeat(64)}`]],
    ['an object without a verdict', [`OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`, 'OSTREE_OBJECT_DONE']],
    ['an object missing from the image', [`OSTREE_OBJECT_MISSING ${staleObject}`, `OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`, 'OSTREE_OBJECT_DONE']],
  ])('relocates nothing and proves nothing stale on an incomplete probe (%s)', (_label, lines) => {
    const result = runGate([goFinding(liveObject, 'GO-LIVE'), goFinding(staleObject, 'GO-STALE')], {
      sbom: objectSbom,
      vendorCheckOutput: probe(lines),
    });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_STALE_BASE_OBJECTS=0');
    expect(result.output).toContain('GRYPE_VENDOR_PENDING=0');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=2');
    expect(readOut(result, 'ostree-objects.json').complete).toBe(false);
    // WI-10006045: retried once, then the log says WHY nothing was relocated.
    expect(result.podmanCalls.filter((call) => call.includes('check-update'))).toHaveLength(2);
    expect(result.output).toContain('OSTREE_PROBE_RETRY attempt 1 incomplete');
    expect(result.output).toMatch(/GRYPE_OSTREE_PROBE=INCOMPLETE \(\d+ of 2 objects resolved\)/);
  });

  // WI-10006045. Measured 2026-10-03 on the P-012 B bake: one write to /tmp in the probe
  // container failed ("Transport endpoint is not connected"), 111 of 117 objects resolved, the
  // probe counted as incomplete and 187 RPM-owned findings stayed actionable.
  it('retries an incomplete probe once, and classifies from the complete retry', () => {
    const result = runGate([goFinding(liveObject, 'GO-LIVE'), goFinding(staleObject, 'GO-STALE'), goInPapercuspBinary], {
      sbom: objectSbom,
      vendorCheckOutput: probe([`OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`, '/bin/sh: line 16: /tmp/same-size: Transport endpoint is not connected']),
      vendorCheckRetryOutput: probe([
        `OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`,
        `OSTREE_OBJECT_STALE ${staleObject} ${'c'.repeat(64)}`,
        'OSTREE_OBJECT_DONE',
      ]),
    });

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('OSTREE_PROBE_RETRY attempt 1 incomplete');
    expect(result.output).toContain('GRYPE_OSTREE_PROBE=complete (2 of 2 objects resolved)');
    expect(result.output).toContain('GRYPE_VENDOR_PENDING=1');
    expect(result.output).toContain('GRYPE_STALE_BASE_OBJECTS=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    expect(readOut(result, 'ostree-objects.json').complete).toBe(true);
    expect(existsSync(join(result.out, 'vendor-check.attempt1.log'))).toBe(true);
    // The probe's scratch files live on a tmpfs, never on the image rootfs.
    // (The stub logs argv with newlines inside the object list, so match the call's first line.)
    expect(result.podmanCalls.filter((call) => call.startsWith('run ') && call.includes('--tmpfs /tmp'))).toHaveLength(2);
  });

  it('does not retry a complete probe', () => {
    const result = runGate([goFinding(liveObject, 'GO-LIVE')], {
      sbom: objectSbom,
      vendorCheckOutput: probe([`OSTREE_OBJECT_LIVE ${liveObject} /usr/bin/toolbox`, 'OSTREE_OBJECT_DONE']),
    });
    expect(result.podmanCalls.filter((call) => call.includes('check-update'))).toHaveLength(1);
    expect(result.output).not.toContain('OSTREE_PROBE_RETRY');
    expect(result.output).toContain('GRYPE_OSTREE_PROBE=complete (1 of 1 objects resolved)');
  });
});
