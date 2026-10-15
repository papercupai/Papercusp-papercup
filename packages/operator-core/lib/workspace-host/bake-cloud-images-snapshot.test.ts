/**
 * Regression guard for EI-22355025813361885.
 *
 * Bash reads compound commands lazily. An in-place rewrite of the bake entrypoint
 * during a long build can therefore splice a later function body into the running
 * interpreter even when the source parsed cleanly at launch. The real entrypoint
 * now copies + syntax-checks itself and re-execs the copy before setup. This test
 * runs the real (non-dry-run) control flow against a temporary fake toolchain,
 * rewrites the later `bake_one` function while the fake build is still sleeping,
 * and proves the guarded run completes from its startup snapshot. A permanent
 * pre-fix control keeps the behavioral assertion falsifiable without mutating the
 * shared checkout.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceHostBootcBakeManifest, workspaceHostBootcCloudArtifact } from './bootc-bake-manifest';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'infra/images/bootc/bake-cloud-images.sh');
const HEALTH = join(ROOT, 'infra/images/bootc/p307-build-health.sh');
const CONTAINERFILE = join(ROOT, 'infra/images/bootc/workspace-host.Containerfile');
const HOST_PREPARE = join(ROOT, 'infra/images/bootc/papercusp-host-prepare.sh');
const HOST_PREPARE_UNIT = join(ROOT, 'infra/images/bootc/papercusp-host-prepare.service');
const GOOGLE_OSLOGIN_TMPFILES = join(ROOT, 'infra/images/bootc/papercusp-google-oslogin.conf');
const IMAGE_BUILD_PROBE = join(ROOT, 'infra/images/bootc/p306-image-build-probe.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const CONTAINERFILE_SOURCE = readFileSync(CONTAINERFILE, 'utf8');
const HOST_PREPARE_SOURCE = readFileSync(HOST_PREPARE, 'utf8');
const HOST_PREPARE_UNIT_SOURCE = readFileSync(HOST_PREPARE_UNIT, 'utf8');
const GOOGLE_OSLOGIN_TMPFILES_SOURCE = readFileSync(GOOGLE_OSLOGIN_TMPFILES, 'utf8');
const IMAGE_BUILD_PROBE_SOURCE = readFileSync(IMAGE_BUILD_PROBE, 'utf8');
const SNAPSHOT_MARKER = '# EI-22355025813361885 — freeze the entrypoint';
// WI-10005946: the exact auditor-resolution line image-secret-scan.sh ships, so the fixture's fake
// supply chain resolves the auditor the way the real scan will.
const SECRET_SCAN_AUDITOR_LINE = (() => {
  const line = readFileSync(join(ROOT, 'infra/images/bootc/image-secret-scan.sh'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('AUDITOR='));
  if (!line) throw new Error('image-secret-scan.sh must define AUDITOR= at the start of a line');
  return line;
})();

function withoutSnapshotGuard(): string {
  const start = SOURCE.indexOf(SNAPSHOT_MARKER);
  const end = SOURCE.indexOf('set -uo pipefail\n', start);
  expect(start, 'snapshot guard marker must be present in the shipped script').toBeGreaterThan(-1);
  expect(end, 'snapshot guard must precede set -uo pipefail').toBeGreaterThan(start);
  return SOURCE.slice(0, start) + SOURCE.slice(end);
}

function runFixture(
  script: string,
  render: 'raw' | 'archive' | 'empty' | 'stale' = 'raw',
  release?: { root?: string; version?: string },
  sourceImage?: { ref: string; exists?: boolean },
  inhibitFails = false,
  diskMetadata: 'pass' | 'bad-release-dir' | 'bad-firewall-config' | 'missing-root' = 'pass',
  /**
   * WI-10005761. imageRelease: what the pinned image answers at /opt/papercusp/current (default:
   * the --release-version asked for, or none). clouds: the --clouds list (default gcp).
   */
  options: {
    /** A refused supply-chain scan must prevent disk rendering. */
    supplyChainRefused?: boolean;
    imageRelease?: string;
    clouds?: string;
    /**
     * WI-10005766. Where the build context lives. Default: the bare temp dir (no git), baked with
     * --allow-unpinned-context. 'clean' / 'dirty': a git repo whose infra/images/bootc subdirectory
     * is the context, committed, then (dirty) given one uncommitted edit before the bake starts.
     */
    git?: 'clean' | 'dirty';
    /** Pass --allow-unpinned-context. Default: true outside git, false in a git context. */
    allowUnpinned?: boolean;
    /**
     * WI-10005910. What step 3d's native-addon probe answers. Default 'ok' (11 loaded, 1 foreign
     * prebuild skipped); 'fail' is the measured stream9 rocksdb-native GLIBCXX_3.4.30 failure.
     */
    addonProbe?: 'ok' | 'fail' | 'empty' | 'silent' | 'podman-error';
    /** WI-10005960. What the storage-hygiene stub's `precheck` answers (default 'ok'). */
    hygienePrecheck?: 'ok' | 'fail';
    /**
     * WI-10005946. Where the secret scan's release auditor is. 'env' (default): a fixture file
     * named by PAPERCUSP_RELEASE_AUDITOR. 'source-tree': git mode only, the repo's own
     * papercusp-desktop/bin/audit-release-bundle.py with the env var empty, so the bake must
     * resolve it. 'missing': no auditor anywhere and the env var empty.
     */
    auditor?: 'env' | 'source-tree' | 'missing';
    genericToolsMissing?: boolean;
  } = {},
): {
  status: number;
  output: string;
  files: string[];
  outFiles: string[];
  manifest: unknown;
  buildArgs: string[];
  podmanCalls: string[];
  inhibitCalls: string[];
  /** WI-10005766: the bytes the fake build read from its -f Containerfile (null: build never ran). */
  builtContainerfile: string | null;
  /** WI-10005946: "found|missing <path>" — the auditor the supply chain resolved (null: never ran). */
  supplyChainAuditor: string | null;
  /** WI-10006045: the argv the bake handed the supply chain, one per line (null: never ran). */
  supplyChainArgs: string[] | null;
  /** WI-10005766: the context directory the fixture baked from, and its HEAD in git mode. */
  context: string;
  contextCommit: string | null;
  out: string;
  /** WI-10005960: each storage-hygiene call as "<args> build-started=0|1", in order. */
  hygieneCalls: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'ei-223550-bake-'));
  // WI-10005766: in git mode the context is a subdirectory of a repo, so the bake's committed-tree
  // comparison runs through a non-empty show-prefix exactly as it does in the real checkout. Marker
  // files, TMPDIR, bin and out stay in `dir`, outside the repo, so they never dirty the context.
  const ctx = options.git ? join(dir, 'repo', 'infra', 'images', 'bootc') : dir;
  mkdirSync(ctx, { recursive: true });
  const source = join(ctx, 'bake-cloud-images.sh');
  const health = join(ctx, 'p307-build-health.sh');
  const liveContainerfile = join(ctx, 'workspace-host.Containerfile');
  const builtContainerfilePath = join(dir, 'built-containerfile');
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const mutationMarker = join(dir, 'source-mutated');
  const buildMarker = join(dir, 'build-started');
  const supplyChainMarker = join(dir, 'supply-chain-ran');
  const buildArgsPath = join(dir, 'build-args');
  const podmanCallsPath = join(dir, 'podman-calls');
  const inhibitCallsPath = join(dir, 'udisks2-inhibit-calls');
  const inhibitLock = join(dir, 'udisks2-inhibit.lock');
  const key = join(dir, 'release.key');
  const pubkey = join(dir, 'release.pub');
  const releaseRoot = release?.root ?? join(dir, 'release-root');

  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(join(releaseRoot, 'serve.mjs'), 'fixture release\n');
  if (render === 'stale') {
    mkdirSync(join(out, 'gcp', 'image'), { recursive: true });
    writeFileSync(join(out, 'gcp', 'image', 'disk.raw'), 'previous run');
  }
  writeFileSync(source, script, { mode: 0o755 });
  copyFileSync(HEALTH, health);
  chmodSync(source, 0o755);
  chmodSync(health, 0o755);
  // WI-10005960: the real helper drives rootful podman storage; the bake's wiring is what this
  // suite pins (bake-storage-hygiene.test.ts pins the helper), so a recording stub stands in.
  const hygieneStub = join(dir, 'bake-storage-hygiene-stub');
  const hygieneCallsPath = join(dir, 'hygiene-calls');
  writeFileSync(hygieneStub, `#!/usr/bin/env bash
started=0; [ -e "$BAKE_TEST_BUILD_MARKER" ] && started=1
printf '%s build-started=%s\\n' "$*" "$started" >> "$BAKE_TEST_HYGIENE_CALLS"
if [ "$1" = precheck ] && [ "$BAKE_TEST_HYGIENE_PRECHECK" = fail ]; then
  echo 'BAKE_RESULT=FAILED storage-headroom 3GiB free for fixture, need >= 64GiB'
  exit 1
fi
exit 0
`, { mode: 0o755 });
  writeFileSync(key, 'temporary private key\n');
  writeFileSync(pubkey, 'temporary public key\n');

  // The build stub deliberately rewrites the later bake_one function while the
  // parent shell is waiting. Rewrite the existing inode rather than replacing
  // it, matching the real editor hazard without touching the shared checkout.
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
set -euo pipefail
subcommand="\${1:-}"
shift || true
printf '%s\\n' "$subcommand $*" >> "$BAKE_TEST_PODMAN_CALLS"

case "$subcommand" in
  info)
    printf 'overlay\\n'
    ;;
  build)
    : > "$BAKE_TEST_BUILD_MARKER"
    printf '%s\\n' "$@" > "$BAKE_TEST_BUILD_ARGS"
    # WI-10005766: an agent edits the LIVE Containerfile while the build runs. Record what the
    # build's own -f file holds after that edit: the snapshot must not see it.
    printf 'LIVE EDIT\\n' > "$BAKE_TEST_LIVE_CONTAINERFILE"
    containerfile=""; previous=""
    for arg in "$@"; do
      [ "$previous" = "-f" ] && containerfile="$arg"
      previous="$arg"
    done
    cat "$containerfile" > "$BAKE_TEST_BUILT_CONTAINERFILE"
    sleep 0.15
    mutation_tmp="$(mktemp "$BAKE_TEST_SOURCE.XXXXXX")"
    sed '/^bake_one() {/a if (' "$BAKE_TEST_SOURCE" > "$mutation_tmp"
    cat "$mutation_tmp" > "$BAKE_TEST_SOURCE"
    rm -f "$mutation_tmp"
    : > "$BAKE_TEST_MUTATION_MARKER"
    sleep 0.15
    ;;
  push|pull)
    ;;
  image)
    [ "\${1:-}" = "exists" ]
    if [ "\${2:-}" = "$BAKE_TEST_SOURCE_IMAGE" ] && [ "$BAKE_TEST_SOURCE_EXISTS" != "1" ]; then
      exit 1
    fi
    ;;
  tag)
    ;;
  run)
    is_skopeo=0
    output_dir=""
    for arg in "$@"; do
      [ "$arg" = "skopeo" ] && is_skopeo=1
    done
    if [ "$is_skopeo" -eq 1 ]; then
      printf 'sha256:%064d\\n' 1
      exit 0
    fi
    # WI-10005761: step 3c reads the release back out of the pinned image.
    for arg in "$@"; do
      case "$arg" in *PAPERCUSP_IMAGE_RELEASE*)
        case "$BAKE_TEST_IMAGE_RELEASE" in
          '') printf 'PAPERCUSP_IMAGE_RELEASE_NONE=1\\n' ;;
          podman-error) printf 'Error: image not known\\n' >&2; exit 125 ;;
          silent) ;;
          dangling) printf 'PAPERCUSP_IMAGE_RELEASE_INVALID=dangling:releases/gone\\n' ;;
          *) printf 'PAPERCUSP_IMAGE_RELEASE=%s\\n' "$BAKE_TEST_IMAGE_RELEASE" ;;
        esac
        exit 0 ;;
      esac
    done
    # WI-10005910: step 3d dlopens every native addon with the release's own node.
    for arg in "$@"; do
      case "$arg" in *PAPERCUSP_ADDON_PROBE*)
        case "$BAKE_TEST_ADDON_PROBE" in
          fail) printf 'PAPERCUSP_ADDON_FAIL node_modules/rocksdb-native/prebuilds/linux-x64/rocksdb-native.node :: version GLIBCXX_3.4.30 not found\\nPAPERCUSP_ADDON_PROBE ok=10 fail=1 skipped=0\\n' ;;
          empty) printf 'PAPERCUSP_ADDON_PROBE ok=0 fail=0 skipped=0\\n' ;;
          silent) ;;
          podman-error) printf 'Error: executable file not found in $PATH\\n' >&2; exit 127 ;;
          *) printf 'PAPERCUSP_ADDON_SKIP node_modules/x/prebuilds/darwin-arm64/x.node\\nPAPERCUSP_ADDON_PROBE ok=11 fail=0 skipped=1\\n' ;;
        esac
        exit 0 ;;
      esac
    done
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-v" ]; then
        output_dir="\${arg%%:/output}"
        break
      fi
      previous="$arg"
    done
    [ -n "$output_dir" ]
    case "$BAKE_TEST_RENDER" in
      archive)
        mkdir -p "$output_dir/gce" "$output_dir/input"
        printf 'fake rendered disk\\n' > "$output_dir/input/disk.raw"
        tar -czf "$output_dir/gce/image.tar.gz" -C "$output_dir/input" disk.raw
        ;;
      empty|stale) ;;
      *)
        mkdir -p "$output_dir/image"
        printf 'fake rendered disk\\n' > "$output_dir/image/disk.raw"
        ;;
    esac
    ;;
  *)
    printf 'unexpected fake podman subcommand: %s\\n' "$subcommand" >&2
    exit 1
    ;;
esac
`, { mode: 0o755 });
  chmodSync(join(bin, 'podman'), 0o755);
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-n" ]; then shift; fi
exec "$@"
`, { mode: 0o755 });
  chmodSync(join(bin, 'sudo'), 0o755);
  writeFileSync(join(bin, 'losetup'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--find" ]; then
  printf '/dev/loop-papercusp-test\\n'
  exit 0
fi
if [ "\${1:-}" = "--detach" ]; then exit 0; fi
printf 'unexpected fake losetup call: %s\\n' "$*" >&2
exit 1
`, { mode: 0o755 });
  chmodSync(join(bin, 'losetup'), 0o755);
  writeFileSync(join(bin, 'lsblk'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$BAKE_TEST_DISK_METADATA" = "missing-root" ]; then
  printf '/dev/loop-papercusp-testp3 xfs boot\\n'
else
  printf '/dev/loop-papercusp-testp4 xfs root\\n'
fi
`, { mode: 0o755 });
  chmodSync(join(bin, 'lsblk'), 0o755);
  writeFileSync(join(bin, 'udevadm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  chmodSync(join(bin, 'udevadm'), 0o755);
  writeFileSync(join(bin, 'mount'), `#!/usr/bin/env bash
set -euo pipefail
mount_dir="\${@: -1}"
release_dir="$mount_dir/ostree/deploy/default/deploy/test.0/opt/papercusp/releases/$BAKE_TEST_RELEASE_VERSION"
mkdir -p "$release_dir/bin"
printf 'fixture release\\n' > "$release_dir/serve.mjs"
printf '#!/bin/sh\\n' > "$release_dir/bin/node"
chmod 0640 "$release_dir/serve.mjs"
chmod 0755 "$release_dir/bin/node"
ln -s "releases/$BAKE_TEST_RELEASE_VERSION" "\${release_dir%/releases/*}/current"
deployment_root="\${release_dir%/opt/papercusp/releases/*}"
mkdir -p "$deployment_root/etc/sysconfig" "$deployment_root/etc/nftables" \
  "$deployment_root/etc/systemd/system/multi-user.target.wants" \
  "$deployment_root/usr/lib/systemd/system"
if [ "$BAKE_TEST_DISK_METADATA" = "bad-firewall-config" ]; then
  printf '%s\\n' '# base sample, no Papercusp include' > "$deployment_root/etc/sysconfig/nftables.conf"
else
  printf '%s\\n' 'include "/etc/nftables/papercusp-workspace-host.nft"' > "$deployment_root/etc/sysconfig/nftables.conf"
fi
chmod 0600 "$deployment_root/etc/sysconfig/nftables.conf"
printf '%s\\n' 'table inet papercusp_workspace_host {' '}' > "$deployment_root/etc/nftables/papercusp-workspace-host.nft"
printf '%s\\n' '[Unit]' 'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service' 'After=local-fs.target systemd-tmpfiles-setup.service nftables.service' \
  > "$deployment_root/usr/lib/systemd/system/papercusp-host-prepare.service"
printf '%s\\n' '[Unit]' > "$deployment_root/usr/lib/systemd/system/nftables.service"
ln -s /usr/lib/systemd/system/nftables.service \
  "$deployment_root/etc/systemd/system/multi-user.target.wants/nftables.service"
ln -s /usr/lib/systemd/system/papercusp-host-prepare.service \
  "$deployment_root/etc/systemd/system/multi-user.target.wants/papercusp-host-prepare.service"
`, { mode: 0o755 });
  chmodSync(join(bin, 'mount'), 0o755);
  writeFileSync(join(bin, 'umount'), `#!/usr/bin/env bash
set -euo pipefail
mount_dir="\${1:?mount directory required}"
rm -rf -- "$mount_dir/ostree"
`, { mode: 0o755 });
  chmodSync(join(bin, 'umount'), 0o755);
  writeFileSync(join(bin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
target="\${@: -1}"
case "$target" in
  */ostree/deploy/*/etc/sysconfig/nftables.conf)
    printf '0:0:600:regular file\\n'
    ;;
  */ostree/deploy/*/opt/papercusp/releases/*/serve.mjs)
    printf '0:912:640:regular file\\n'
    ;;
  */ostree/deploy/*/opt/papercusp/releases/*/bin/node)
    printf '0:912:755:regular file\\n'
    ;;
  */ostree/deploy/*/opt/papercusp/releases/*)
    if [ "$BAKE_TEST_DISK_METADATA" = "bad-release-dir" ]; then
      printf '0:0:755:directory\\n'
    else
      printf '0:912:750:directory\\n'
    fi
    ;;
  *)
    exec /usr/bin/stat "$@"
    ;;
esac
`, { mode: 0o755 });
  chmodSync(join(bin, 'stat'), 0o755);
  writeFileSync(join(bin, 'udisks2-inhibit'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$BAKE_TEST_UDISKS_INHIBIT_CALLS"
if [ "$BAKE_TEST_UDISKS_INHIBIT_FAIL" = "1" ]; then exit 73; fi
exec "$@"
`, { mode: 0o755 });
  chmodSync(join(bin, 'udisks2-inhibit'), 0o755);
  for (const tool of ['syft', 'grype']) {
    writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    chmodSync(join(bin, tool), 0o755);
  }
  // WI-10005946: the fake supply chain resolves the auditor with the REAL image-secret-scan.sh
  // line, from the snapshot directory the bake runs it in, and records what that line finds.
  writeFileSync(join(ctx, 'release-supply-chain.sh'), `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
${SECRET_SCAN_AUDITOR_LINE}
if [ -f "$AUDITOR" ]; then state=found; else state=missing; fi
printf '%s %s\\n' "$state" "$AUDITOR" > "$BAKE_TEST_SUPPLY_CHAIN_MARKER"
printf '%s\\n' "$@" > "$BAKE_TEST_SUPPLY_CHAIN_MARKER.args"
exit ${options.supplyChainRefused ? 3 : 0}
`, { mode: 0o755 });
  chmodSync(join(ctx, 'release-supply-chain.sh'), 0o755);
  writeFileSync(liveContainerfile, 'FROM scratch\n# original fixture Containerfile\n');

  const auditorMode = options.auditor ?? 'env';
  const fixtureAuditor = join(dir, 'fixture-audit-release-bundle.py');
  if (auditorMode === 'env') writeFileSync(fixtureAuditor, '# fixture auditor\n');
  if (auditorMode === 'source-tree') {
    if (!options.git) throw new Error("auditor: 'source-tree' needs a git fixture: the context must sit in a repo");
    const repoAuditor = join(dir, 'repo', 'papercusp-desktop', 'bin', 'audit-release-bundle.py');
    mkdirSync(join(repoAuditor, '..'), { recursive: true });
    writeFileSync(repoAuditor, '# repo auditor\n');
  }

  let contextCommit: string | null = null;
  if (options.git) {
    const repo = join(dir, 'repo');
    const git = (...args: string[]): string => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture context');
    contextCommit = git('rev-parse', 'HEAD');
    if (options.git === 'dirty') writeFileSync(join(ctx, 'papercusp-uncommitted.conf'), 'not committed\n');
  }

  const optionalArgs: string[] = [];
  if (options.allowUnpinned ?? !options.git) optionalArgs.push('--allow-unpinned-context');
  if (release?.root !== undefined) optionalArgs.push('--release-root', release.root);
  if (release?.version !== undefined) optionalArgs.push('--release-version', release.version);
  if (sourceImage !== undefined) optionalArgs.push('--source-image', sourceImage.ref);

  const result = spawnSync(
    'bash',
    [
      source,
      '--registry',
      'localhost/test',
      '--key',
      key,
      '--pubkey',
      pubkey,
      '--clouds',
      options.clouds ?? 'gcp',
      '--out',
      out,
      ...optionalArgs,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BAKE_TEST_SOURCE: source,
        BAKE_TEST_MUTATION_MARKER: mutationMarker,
        BAKE_TEST_BUILD_MARKER: buildMarker,
        BAKE_TEST_BUILD_ARGS: buildArgsPath,
        BAKE_TEST_PODMAN_CALLS: podmanCallsPath,
        BAKE_TEST_UDISKS_INHIBIT_CALLS: inhibitCallsPath,
        BAKE_TEST_UDISKS_INHIBIT_FAIL: inhibitFails ? '1' : '0',
        BAKE_TEST_SOURCE_IMAGE: sourceImage?.ref ?? '',
        BAKE_TEST_SOURCE_EXISTS: sourceImage?.exists === false ? '0' : '1',
        BAKE_TEST_SUPPLY_CHAIN_MARKER: supplyChainMarker,
        PAPERCUSP_RELEASE_AUDITOR: auditorMode === 'env' ? fixtureAuditor : '',
        // These tools are not executed by this suite's fake supply chain. Their presence is
        // the early setup contract; image-secret-scan-binding tests exercise the actual step.
        PAPERCUSP_BUNDLED_SECRET_POLICY_EVALUATOR: options.genericToolsMissing ? join(dir, 'missing-policy') : join(ROOT, 'apps/operator/lib/release/bootc-image-release-request-cli.ts'),
        PAPERCUSP_BUNDLED_SECRET_POLICY_RUNNER: '/bin/true',
        GITLEAKS_BIN: '/bin/true',
        BAKE_TEST_LIVE_CONTAINERFILE: liveContainerfile,
        BAKE_TEST_BUILT_CONTAINERFILE: builtContainerfilePath,
        BAKE_TEST_RENDER: render,
        // The fake disk holds whatever release the image carries.
        BAKE_TEST_RELEASE_VERSION: options.imageRelease ?? release?.version ?? '',
        BAKE_TEST_IMAGE_RELEASE: options.imageRelease ?? release?.version ?? '',
        BAKE_TEST_ADDON_PROBE: options.addonProbe ?? 'ok',
        BAKE_TEST_DISK_METADATA: diskMetadata,
        RELEASE_STORAGE_DRIVER: 'overlay',
        UDISKS2_INHIBIT_BIN: join(bin, 'udisks2-inhibit'),
        PAPERCUSP_UDISKS2_INHIBIT_LOCK: inhibitLock,
        P307_BUILD_HEALTH_DISABLE: '1',
        BAKE_STORAGE_HYGIENE: hygieneStub,
        BAKE_TEST_HYGIENE_CALLS: hygieneCallsPath,
        BAKE_TEST_HYGIENE_PRECHECK: options.hygienePrecheck ?? 'ok',
        TMPDIR: dir,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    files: readdirSync(dir),
    outFiles: readdirSync(out, { recursive: true }).map(String),
    manifest: existsSync(join(out, 'bake-manifest.json'))
      ? JSON.parse(readFileSync(join(out, 'bake-manifest.json'), 'utf8'))
      : null,
    buildArgs: existsSync(buildArgsPath)
      ? readFileSync(buildArgsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
    podmanCalls: existsSync(podmanCallsPath)
      ? readFileSync(podmanCallsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
    inhibitCalls: existsSync(inhibitCallsPath)
      ? readFileSync(inhibitCallsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
    builtContainerfile: existsSync(builtContainerfilePath) ? readFileSync(builtContainerfilePath, 'utf8') : null,
    supplyChainAuditor: existsSync(supplyChainMarker) ? readFileSync(supplyChainMarker, 'utf8').trim() : null,
    supplyChainArgs: existsSync(`${supplyChainMarker}.args`)
      ? readFileSync(`${supplyChainMarker}.args`, 'utf8').split(/\r?\n/).filter(Boolean)
      : null,
    context: ctx,
    contextCommit,
    out,
    hygieneCalls: existsSync(hygieneCallsPath)
      ? readFileSync(hygieneCallsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [],
  };
}

function runImageBuildProbeStorageFixture(
  nativeOverlayDiff: 'true' | 'false',
  mountProgramMarker: boolean,
): { status: number; output: string; podmanCalls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ei-227724-p306-storage-'));
  const bin = join(dir, 'bin');
  const graphRoot = join(dir, 'graph-root');
  const runRoot = join(dir, 'run-root');
  const privateStorageParent = join(dir, 'private-storage-parent');
  const privateRunParent = join(dir, 'private-run-parent');
  const buildLogPath = join(dir, 'p306-build.log');
  const callsPath = join(dir, 'podman-calls');

  mkdirSync(join(bin), { recursive: true });
  mkdirSync(join(graphRoot, 'overlay'), { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  if (mountProgramMarker) writeFileSync(join(graphRoot, 'overlay', '.has-mount-program'), 'true\n');
  writeFileSync(
    join(bin, 'podman'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'raw_args="$*"',
      'while [[ "${1:-}" == --root || "${1:-}" == --runroot ]]; do shift 2; done',
      'subcommand="${1:-}"',
      'shift || true',
      'args="$raw_args"',
      'printf "%s\\n" "$args" >> "$P306_TEST_CALLS"',
      'if [[ "$subcommand" == info ]]; then',
      '  format="${2:-}"',
      '  case "$format" in',
      '    *GraphDriverName*) printf "overlay\\n" ;;',
      '    *GraphRoot*) printf "%s\\n" "$P306_TEST_GRAPH_ROOT" ;;',
      '    *RunRoot*) printf "%s\\n" "$P306_TEST_RUN_ROOT" ;;',
      '    *GraphStatus*) printf "%s\\n" "$P306_TEST_NATIVE_OVERLAY_DIFF" ;;',
      '    *) printf "\\n" ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [[ "$args" == build\ * || "$args" == *" build "* ]]; then exit 1; fi',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'podman'), 0o755);

  const result = spawnSync('bash', [IMAGE_BUILD_PROBE], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      P306_TEST_CALLS: callsPath,
      P306_TEST_GRAPH_ROOT: graphRoot,
      P306_TEST_RUN_ROOT: runRoot,
      P306_TEST_NATIVE_OVERLAY_DIFF: nativeOverlayDiff,
      P306_PRIVATE_STORAGE_PARENT: privateStorageParent,
      P306_PRIVATE_RUN_PARENT: privateRunParent,
      P306_BUILD_LOG: buildLogPath,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const podmanCalls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, output, podmanCalls };
}

describe('bake-cloud-images.sh startup snapshot (EI-22355025813361885)', () => {
  it('refuses missing provider secret-policy tooling before starting a build', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { genericToolsMissing: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('bundled secret policy evaluator missing before bake');
    expect(result.buildArgs).toEqual([]);
  });
  it('refuses duplicate release admission and permits retry after process exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bake-admission-'));
    const start = SOURCE.indexOf('# EI-25301484626869456:');
    const end = SOURCE.indexOf('# End release bake admission.', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const guard = SOURCE.slice(start, end);
    const script = `set -eu\nDRY_RUN=0\nRELEASE_VERSION=0.0.21-test\ndie() { echo "$*"; exit 2; }\n${guard}\n`;
    try {
      const result = spawnSync('bash', ['-c', script + 'bash -c "$CHILD_GUARD" > "$XDG_RUNTIME_DIR/child-output" 2>&1 && exit 9\ntest "$?" -eq 2\ncat "$XDG_RUNTIME_DIR/child-output"\n'], { env: { ...process.env, XDG_RUNTIME_DIR: dir, CHILD_GUARD: script }, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('release bake already active: 0.0.21-test');
      const retry = spawnSync('bash', ['-c', script], { env: { ...process.env, XDG_RUNTIME_DIR: dir }, encoding: 'utf8' });
      expect(retry.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes the vendor package layer for each bake and enforces the vulnerability gate', () => {
    const first = runFixture(SOURCE);
    const second = runFixture(SOURCE);
    const refresh = (args: string[]) => args.find((arg) => arg.startsWith('PAPERCUSP_VENDOR_REFRESH='));
    expect(refresh(first.buildArgs)).toMatch(/^PAPERCUSP_VENDOR_REFRESH=\d+$/);
    expect(refresh(second.buildArgs)).not.toBe(refresh(first.buildArgs));
    expect(first.supplyChainArgs).toContain('--fail-on-vulns');
    expect(CONTAINERFILE_SOURCE).toContain('test -n "$PAPERCUSP_VENDOR_REFRESH"');
  });

  it('does not render a disk or report PASS when the vulnerability scan refuses', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { supplyChainRefused: true });
    expect(result.status).toBe(3);
    expect(result.output).toContain('BAKE_RESULT=REFUSED supply chain exited 3');
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.outFiles).not.toContain('gcp/image/disk.raw');
  });

  it('keeps a live bake on the startup bytes after the source is rewritten', () => {
    const result = runFixture(SOURCE);

    expect(result.status).toBe(0);
    expect(result.output).toContain('BAKE_RESULT=PASS');
    expect(result.output).toContain('### 1/4 build (one image, all clouds)');
    expect(result.output).toContain('gcp: ok');
    expect(result.files).toContain('source-mutated');
    expect(result.files).toContain('build-started');
    expect(result.files).toContain('supply-chain-ran');
    expect(result.outFiles).toContain('bake-manifest.json');
    expect(result.outFiles).toContain('gcp/image/disk.raw');
    expect(result.files.some((name) => name.startsWith('papercusp-bake-cloud-images.'))).toBe(false);
    expect(result.inhibitCalls).toHaveLength(1);
    expect(result.inhibitCalls[0]).toContain('podman run --rm --privileged');
  });

  it('rejects a converted release disk that retained the earlier root:root directory header', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-bad-disk-metadata-root-'));
    try {
      const result = runFixture(
        SOURCE,
        'raw',
        { root: releaseRoot, version: '0.0.18-r21' },
        undefined,
        false,
        'bad-release-dir',
      );

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        'release-directory-metadata:0:0:755:directory:expected=0:912:750:directory',
      );
      expect(result.output).toContain(
        'converted disk did not preserve the immutable release metadata',
      );
      expect(result.manifest).toBeNull();
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('rejects a converted release disk whose nftables config retained the lower-layer sample', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-bad-firewall-config-root-'));
    try {
      const result = runFixture(
        SOURCE,
        'raw',
        { root: releaseRoot, version: '0.0.18-r21' },
        undefined,
        false,
        'bad-firewall-config',
      );

      expect(result.status).toBe(1);
      expect(result.output).toContain('nftables-config-content:# base sample, no Papercusp include');
      expect(result.manifest).toBeNull();
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the host UDisks automount inhibitor cannot guard the renderer', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain('BAKE_UDISKS2_INHIBIT=');
    expect(result.output).toContain('gcp: FAILED');
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.inhibitCalls).toHaveLength(1);
    expect(result.inhibitCalls[0]).toContain('podman run --rm --privileged');
    expect(result.podmanCalls.some((call) => call.startsWith('run --rm --privileged'))).toBe(false);
  });

  it('falsifiability control: the pre-fix live-source shape is broken by the same rewrite', () => {
    const result = runFixture(withoutSnapshotGuard());

    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.output).toMatch(/syntax error/i);
  });

  it('normalizes the real GCE archive layout into a releasable GCP-only manifest', () => {
    const result = runFixture(SOURCE, 'archive');
    expect(result.status, result.output).toBe(0);
    const artifact = workspaceHostBootcCloudArtifact(parseWorkspaceHostBootcBakeManifest(result.manifest), 'gcp');
    const bytes = Buffer.from('fake rendered disk\n');
    expect(artifact.sizeBytes).toBe(bytes.length);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.outFiles).toContain('gcp/image/disk.raw');
  });

  it.each(['empty', 'stale'] as const)('refuses a %s render output instead of publishing success', (render) => {
    const result = runFixture(SOURCE, render);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(() => parseWorkspaceHostBootcBakeManifest(result.manifest)).toThrow();
  });

  it('selects the optional named release context only when both P-305 release options are present', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-release-root-'));
    try {
      const result = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.18-r21' });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(
        'BAKE_RELEASE_DISK_METADATA=PASS version=0.0.18-r21',
      );
      expect(result.buildArgs).toEqual(
        expect.arrayContaining([
          '--target',
          'workspace-host-release',
          '--build-context',
          `papercusp-release=${releaseRoot}`,
          '--build-arg',
          'PAPERCUSP_RELEASE_VERSION=0.0.18-r21',
        ]),
      );
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  // WI-10005761: a bootc release is image CONTENT, so the manifest records the release read back
  // out of the pinned image (never restated from the flag) and release consumers refuse a mismatch.
  describe('loads every native addon the release ships before rendering (WI-10005910)', () => {
    const withRelease = (addonProbe: 'ok' | 'fail' | 'empty' | 'silent' | 'podman-error') => {
      const releaseRoot = mkdtempSync(join(tmpdir(), 'wi10005910-release-root-'));
      try {
        return runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.21-p318r62b' }, undefined, false, 'pass', {
          addonProbe,
        });
      } finally {
        rmSync(releaseRoot, { recursive: true, force: true });
      }
    };
    const rendered = (calls: string[]) => calls.some((call) => call.startsWith('run --rm --privileged'));

    it('runs the probe with the release node, offline, in the pinned image, and records the count', () => {
      const result = withRelease('ok');
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('BAKE_NATIVE_ADDONS=ok:11 skipped:1');
      expect(result.output).toContain('PAPERCUSP_ADDON_SKIP node_modules/x/prebuilds/darwin-arm64/x.node');
      const probe = result.podmanCalls.find((call) => call.includes('PAPERCUSP_ADDON_PROBE'));
      expect(probe, result.podmanCalls.join('\n')).toBeDefined();
      expect(probe).toContain('--entrypoint /opt/papercusp/releases/0.0.21-p318r62b/bin/node');
      expect(probe).toContain('--network=none');
      expect(probe).toContain('--pull=never');
      expect(probe).toMatch(/@sha256:/);
      expect(rendered(result.podmanCalls)).toBe(true);
    });

    it.each([
      ['an addon that does not load (the stream9 GLIBCXX_3.4.30 case)', 'fail', '1 native addon(s) in release 0.0.21-p318r62b do not load'],
      ['a probe that loaded no addon', 'empty', 'loaded no addon'],
      ['a probe with no verdict', 'silent', 'gave no verdict'],
      ['a probe that could not run', 'podman-error', 'could not run'],
    ] as const)('fails the bake before rendering on %s', (_name, addonProbe, message) => {
      const result = withRelease(addonProbe);
      expect(result.status).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).not.toContain('BAKE_NATIVE_ADDONS=');
      expect(result.manifest).toBeNull();
      expect(rendered(result.podmanCalls)).toBe(false);
    });

    it('surfaces the failing addon and its loader error in the bake log', () => {
      const result = withRelease('fail');
      expect(result.output).toContain('PAPERCUSP_ADDON_FAIL node_modules/rocksdb-native/prebuilds/linux-x64/rocksdb-native.node');
      expect(result.output).toContain('GLIBCXX_3.4.30');
    });

    it('falsifiability control: without the fail branch the same unloadable release renders', () => {
      const failBranch = 'if [ "$addon_fail" -gt 0 ]; then';
      expect(SOURCE).toContain(failBranch);
      const mutant = SOURCE.replace(failBranch, 'if false; then');
      expect(mutant).not.toBe(SOURCE);
      const releaseRoot = mkdtempSync(join(tmpdir(), 'wi10005910-mutant-root-'));
      try {
        const result = runFixture(mutant, 'raw', { root: releaseRoot, version: '0.0.21-p318r62b' }, undefined, false, 'pass', {
          addonProbe: 'fail',
        });
        expect(result.status, result.output).toBe(0);
        expect(rendered(result.podmanCalls)).toBe(true);
      } finally {
        rmSync(releaseRoot, { recursive: true, force: true });
      }
    });

    it('does not run the probe on an OS-only bake, which carries no release to load', () => {
      const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { addonProbe: 'fail' });
      expect(result.status, result.output).toBe(0);
      expect(result.podmanCalls.some((call) => call.includes('PAPERCUSP_ADDON_PROBE'))).toBe(false);
      expect(result.output).not.toContain('BAKE_NATIVE_ADDONS=');
    });
  });

  describe('records the release the image carries (WI-10005761)', () => {
    it('records the built release and checks it on the disk', () => {
      const releaseRoot = mkdtempSync(join(tmpdir(), 'wi10005761-release-root-'));
      try {
        const result = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.21-p318r63' });
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('BAKE_IMAGE_RELEASE=0.0.21-p318r63');
        expect(parseWorkspaceHostBootcBakeManifest(result.manifest).release).toEqual({ version: '0.0.21-p318r63' });
        expect(result.podmanCalls.some((call) => call.includes('--entrypoint /bin/sh') && call.includes('--pull=never'))).toBe(true);
      } finally {
        rmSync(releaseRoot, { recursive: true, force: true });
      }
    });

    it('records an OS-only bake as release null and skips the disk release check', () => {
      const result = runFixture(SOURCE);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('BAKE_IMAGE_RELEASE=none');
      expect(result.output).not.toContain('BAKE_RELEASE_DISK_METADATA');
      expect((result.manifest as { release?: unknown }).release).toBeNull();
    });

    it('derives the release a --source-image reuse carries and checks it on the disk', () => {
      const result = runFixture(SOURCE, 'raw', undefined, { ref: 'localhost/r62b:baked' }, false, 'pass', {
        imageRelease: '0.0.21-p318r62b',
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('BAKE_RELEASE_DISK_METADATA=PASS version=0.0.21-p318r62b');
      expect(parseWorkspaceHostBootcBakeManifest(result.manifest).release).toEqual({ version: '0.0.21-p318r62b' });
    });

    it('checks the AWS raw disk too, not only GCP', () => {
      const releaseRoot = mkdtempSync(join(tmpdir(), 'wi10005761-aws-root-'));
      try {
        const pass = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.21-p318r63' }, undefined, false, 'pass', { clouds: 'aws' });
        expect(pass.status, pass.output).toBe(0);
        expect(pass.output).toContain('BAKE_RELEASE_DISK_METADATA=PASS version=0.0.21-p318r63');
        const bad = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.21-p318r63' }, undefined, false, 'bad-release-dir', {
          clouds: 'aws',
        });
        expect(bad.status).toBe(1);
        expect(bad.output).toContain('aws: FAILED — converted disk did not preserve the immutable release metadata');
        expect(bad.manifest).toBeNull();
      } finally {
        rmSync(releaseRoot, { recursive: true, force: true });
      }
    });

    it('refuses before rendering when the built image carries a different release than --release-version', () => {
      const releaseRoot = mkdtempSync(join(tmpdir(), 'wi10005761-mismatch-root-'));
      try {
        const result = runFixture(SOURCE, 'raw', { root: releaseRoot, version: '0.0.21-p318r63' }, undefined, false, 'pass', {
          imageRelease: '0.0.21-p318r62b',
        });
        expect(result.status).toBe(1);
        expect(result.output).toContain('--release-version 0.0.21-p318r63, but the built image carries 0.0.21-p318r62b');
        expect(result.manifest).toBeNull();
        expect(result.podmanCalls.some((call) => call.startsWith('run --rm --privileged'))).toBe(false);
      } finally {
        rmSync(releaseRoot, { recursive: true, force: true });
      }
    });

    it.each([
      ['a podman failure', 'podman-error', 'could not read the release'],
      ['an empty answer', 'silent', 'gave no verdict'],
      ['a dangling current link', 'dangling', 'unusable /opt/papercusp/current'],
    ] as const)('fails closed on %s instead of recording OS-only', (_name, imageRelease, message) => {
      const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { imageRelease });
      expect(result.status).toBe(1);
      expect(result.output).toContain(message);
      expect(result.manifest).toBeNull();
    });
  });

  it('reuses an explicitly named local image without rebuilding it', () => {
    const sourceImage = 'localhost/p305-release-target-current:20260907-1010';
    const result = runFixture(SOURCE, 'raw', undefined, { ref: sourceImage });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('reuse verified local image (no rebuild)');
    expect(result.files).not.toContain('build-started');
    const pushedImage = result.podmanCalls.find((call) => call.startsWith('push localhost/test/workspace-host:'))?.slice(5);
    expect(pushedImage).toBeTruthy();
    expect(result.podmanCalls).toEqual(
      expect.arrayContaining([
        `image exists ${sourceImage}`,
        `tag ${sourceImage} ${pushedImage}`,
      ]),
    );
    expect(result.podmanCalls.some((call) => call.startsWith('build '))).toBe(false);
  });

  it('refuses a missing source image before tag, push, signing, or rendering', () => {
    const sourceImage = 'localhost/missing:rollback';
    const result = runFixture(SOURCE, 'raw', undefined, { ref: sourceImage, exists: false });

    expect(result.status).toBe(1);
    expect(result.output).toContain(`source image absent from local storage: ${sourceImage}`);
    expect(result.files).not.toContain('build-started');
    expect(result.files).not.toContain('supply-chain-ran');
    expect(result.podmanCalls).toEqual([`image exists ${sourceImage}`]);
  });

  it('refuses source-image plus release-root inputs before invoking Podman', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'p305-mutually-exclusive-root-'));
    try {
      const result = runFixture(
        SOURCE,
        'raw',
        { root: releaseRoot, version: '0.0.18-r21' },
        { ref: 'localhost/existing:r21' },
      );

      expect(result.status).toBe(2);
      expect(result.output).toContain('--source-image is mutually exclusive with --release-root/--release-version');
      expect(result.podmanCalls).toEqual([]);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('refuses a half-configured named release context before invoking Podman', () => {
    const result = runFixture(SOURCE, 'raw', { version: '0.0.18-r21' });
    // The fixture above supplies the version without a root, so this is the
    // negative control for the parser.  (The successful pair is exercised by
    // the test immediately below.)
    expect(result.status).toBe(2);
    expect(result.output).toContain('--release-root and --release-version must be supplied together');
    expect(result.files).not.toContain('build-started');
  });

  it('keeps the OS-only target as the default and puts the release layer behind an explicit target', () => {
    const releaseStage = CONTAINERFILE_SOURCE.indexOf('FROM workspace-host-os AS workspace-host-release\n');
    const defaultStage = CONTAINERFILE_SOURCE.indexOf('FROM workspace-host-os AS workspace-host\n');
    expect(releaseStage).toBeGreaterThan(-1);
    expect(defaultStage).toBeGreaterThan(releaseStage);
    expect(CONTAINERFILE_SOURCE).toContain(
      'RUN --mount=type=bind,from=papercusp-release,source=/,target=/run/papercusp-release,ro',
    );
    expect(CONTAINERFILE_SOURCE).not.toContain(
      'COPY --from=papercusp-release / /opt/papercusp/releases/${PAPERCUSP_RELEASE_VERSION}/',
    );
    expect(SOURCE).toContain('--target workspace-host-release');
    expect(CONTAINERFILE_SOURCE).toContain('ARG PAPERCUSP_RUNTIME_READ_GROUP=papercusp-runtime-read');
    expect(CONTAINERFILE_SOURCE).toContain('install -d -o root -g "$PAPERCUSP_RUNTIME_READ_GROUP" -m 0750');
    expect(HOST_PREPARE_SOURCE).toContain('say "runtime-group PASS"');
    expect(HOST_PREPARE_SOURCE).not.toContain('setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT"');
    expect(HOST_PREPARE_SOURCE).not.toContain('setfacl -R -m "u:$AGENT_USER:rX" "$RUNTIME_ROOT/releases"');
  });

  it('materializes named-context hardlinks before normalizing release metadata', () => {
    const lookup = CONTAINERFILE_SOURCE.indexOf(`find "$RELEASE_DIR" -type f -exec stat -c '%i' -- {} + >/dev/null`);
    const snapshot = CONTAINERFILE_SOURCE.indexOf(`find "$RELEASE_DIR" -type f -links +1 -print0 > "$HARDLINK_PATHS"`);
    const freshCopy = CONTAINERFILE_SOURCE.indexOf(
      `cp --reflink=never --preserve=mode,timestamps -- "$path" "$fresh"`,
    );
    const noHardlinks = CONTAINERFILE_SOURCE.indexOf(
      `[ -z "$(find "$RELEASE_DIR" -type f -links +1 -print -quit)" ]`,
    );
    const normalizeOwner = CONTAINERFILE_SOURCE.indexOf(
      'chown -R "root:${PAPERCUSP_RUNTIME_READ_GROUP}" "$RELEASE_DIR"',
    );
    const releaseMount = CONTAINERFILE_SOURCE.indexOf(
      'RUN --mount=type=bind,from=papercusp-release,source=/,target=/run/papercusp-release,ro',
    );

    expect(lookup).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(lookup);
    expect(freshCopy).toBeGreaterThan(snapshot);
    expect(noHardlinks).toBeGreaterThan(freshCopy);
    expect(normalizeOwner).toBeGreaterThan(noHardlinks);
    expect(releaseMount).toBeLessThan(lookup);
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('committed release hardlinks are five distinct 0:912/0640 inodes');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain(
      'committed runtime readable by service+agent, hidden from SSH; state hidden from agent+SSH',
    );
  });

  it('commits the exact nftables config through a fresh inode and orders host preparation behind it', () => {
    const write = CONTAINERFILE_SOURCE.indexOf('> "$NFTABLES_CONFIG_TMP"');
    const replace = CONTAINERFILE_SOURCE.indexOf('mv -f -- "$NFTABLES_CONFIG_TMP" "$NFTABLES_CONFIG"');
    expect(write).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(write);
    expect(CONTAINERFILE_SOURCE).not.toContain('> /etc/sysconfig/nftables.conf');
    expect(HOST_PREPARE_UNIT_SOURCE).toContain(
      'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service',
    );
    expect(HOST_PREPARE_UNIT_SOURCE).toContain(
      'After=local-fs.target systemd-tmpfiles-setup.service nftables.service',
    );
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('committed nftables config loads the Papercusp ruleset');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('host-prepare requires and follows nftables');
  });

  it('recreates Google OS Login user state at boot instead of committing /var residue', () => {
    expect(GOOGLE_OSLOGIN_TMPFILES_SOURCE).toContain('d /var/google-users.d 0755 root root - -');
    expect(CONTAINERFILE_SOURCE).toContain(
      'COPY papercusp-google-oslogin.conf /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf',
    );
    expect(CONTAINERFILE_SOURCE).toContain('/var/google-users.d');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('test ! -e /var/google-users.d');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain(
      'systemd-tmpfiles --create /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf',
    );
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('expected 755:0:0');
  });

  it('installs OS Login policy on the booted host before sshd and reapplies RPM labels (WI-10005926)', () => {
    const hostPrepareCode = HOST_PREPARE_SOURCE.replace(/^\s*#.*$/gm, '');
    const policyInstall = hostPrepareCode.indexOf('semodule -i "$OSLOGIN_POLICY"');
    const policyVerify = hostPrepareCode.indexOf('semodule -lfull | awk');
    const labelDirectories = hostPrepareCode.indexOf('for path in /var/google-sudoers.d /var/google-users.d; do');
    const labelFiles = hostPrepareCode.indexOf('for path in /etc/oslogin_passwd.cache.bin /etc/oslogin_group.cache; do');
    const complete = hostPrepareCode.indexOf('say "complete"');

    expect(policyInstall, 'host prepare must install the shipped OS Login policy').toBeGreaterThan(-1);
    expect(policyVerify, 'host prepare must verify that semodule loaded OS Login').toBeGreaterThan(policyInstall);
    expect(labelDirectories).toBeGreaterThan(policyVerify);
    expect(labelFiles).toBeGreaterThan(labelDirectories);
    expect(hostPrepareCode.indexOf('restorecon -r "$path"', labelDirectories)).toBeGreaterThan(labelDirectories);
    expect(hostPrepareCode.indexOf('restorecon "$path"', labelFiles)).toBeGreaterThan(labelFiles);
    expect(complete).toBeGreaterThan(labelFiles);
    expect(HOST_PREPARE_UNIT_SOURCE).toMatch(/^After=.*systemd-tmpfiles-setup\.service/m);
    expect(HOST_PREPARE_UNIT_SOURCE).toMatch(/^Requires=.*systemd-tmpfiles-setup\.service/m);
    expect(HOST_PREPARE_UNIT_SOURCE).toMatch(/^Before=sshd\.service$/m);
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain('/usr/share/selinux/packages/oslogin.pp');
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain("rpm -q --scripts google-compute-engine-oslogin");
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain(
      "grep -Fx 'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service'",
    );
    expect(IMAGE_BUILD_PROBE_SOURCE).toContain(
      "grep -Fx 'After=local-fs.target systemd-tmpfiles-setup.service nftables.service'",
    );
    expect(SOURCE).toContain("grep -Fx 'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service'");
    expect(SOURCE).toContain("grep -Fx 'After=local-fs.target systemd-tmpfiles-setup.service nftables.service'");
    for (const sideEffect of [
      'systemctl enable google-oslogin-cache.timer',
      '/sbin/ldconfig',
      'semodule -i /usr/share/selinux/packages/oslogin.pp',
      'restorecon -r /var/google-sudoers.d',
      'restorecon -r /var/google-users.d',
      'restorecon /etc/oslogin_passwd.cache.bin',
      'restorecon /etc/oslogin_group.cache',
    ]) {
      expect(IMAGE_BUILD_PROBE_SOURCE).toContain(sideEffect);
    }
  });
});

const CONTEXT_FREEZE_MARKER = '# ── 0. Freeze the BUILD CONTEXT (WI-10005766)';

/** The pre-WI-10005766 shape: the build reads the live checkout. Stub the manifest fields it would set. */
function withoutContextFreeze(): string {
  const start = SOURCE.indexOf(CONTEXT_FREEZE_MARKER);
  const endMarker = 'BUILD_HEALTH="$HERE/p307-build-health.sh"\n';
  const end = SOURCE.indexOf(endMarker, start);
  expect(start, 'context freeze marker must be present in the shipped script').toBeGreaterThan(-1);
  expect(end, 'context freeze block must end by re-pointing BUILD_HEALTH').toBeGreaterThan(start);
  return (
    SOURCE.slice(0, start) +
    `BUILD_CONTEXT_SHA256=${'0'.repeat(64)}; BUILD_CONTEXT_COMMIT=""; BUILD_CONTEXT_PINNED_JSON=false\n` +
    SOURCE.slice(end + endMarker.length)
  );
}

/** Independent re-implementation of the documented build_context_sha256 scheme. */
function contextSha256(root: string): string {
  const entries: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel))) {
      const relPath = rel === '.' ? `./${name}` : `${rel}/${name}`;
      const st = lstatSync(join(root, relPath));
      if (st.isDirectory()) walk(relPath);
      else if (st.isSymbolicLink()) entries.push(`link ${relPath} -> ${readlinkSync(join(root, relPath))}`);
      else if (st.isFile()) {
        const digest = createHash('sha256').update(readFileSync(join(root, relPath))).digest('hex');
        entries.push(`file ${digest} ${(st.mode & 0o100) !== 0 ? 'x' : '-'} ${relPath}`);
      }
    }
  };
  walk('.');
  const sorted = entries
    .map((line) => ({ line, path: line.replace(/^file [0-9a-f]{64} [x-] |^link /, '').replace(/ -> .*$/, '') }))
    .sort((a, b) => (Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))))
    .map((e) => `${e.line}\n`)
    .join('');
  return createHash('sha256').update(sorted).digest('hex');
}

type BuildContextManifest = { buildContext?: { sha256: string; commit: string | null; pinned: boolean } };

describe('bake-cloud-images.sh build-context snapshot (WI-10005766)', () => {
  it('builds from a frozen snapshot: a live Containerfile edit during the build does not reach it', () => {
    const result = runFixture(SOURCE);
    expect(result.status, result.output).toBe(0);
    expect(result.builtContainerfile).toBe('FROM scratch\n# original fixture Containerfile\n');
    const snapshot = join(result.out, 'build-context');
    expect(result.buildArgs).toEqual(expect.arrayContaining(['-f', join(snapshot, 'workspace-host.Containerfile')]));
    expect(result.buildArgs.at(-1)).toBe(snapshot);
    // The artifact directory sits inside the fixture's context and must not be copied into itself.
    expect(existsSync(join(snapshot, 'out'))).toBe(false);

    const manifest = result.manifest as BuildContextManifest;
    expect(manifest.buildContext).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), commit: null, pinned: false });
    expect(manifest.buildContext?.sha256).toBe(contextSha256(snapshot));
    expect(result.output).toContain(`sha256=${manifest.buildContext?.sha256} commit=none pinned=false`);
    expect(() => parseWorkspaceHostBootcBakeManifest(result.manifest)).not.toThrow();
  });

  it('falsifiability control: the pre-fix live-context shape builds the mid-bake edit', () => {
    const result = runFixture(withoutContextFreeze());
    expect(result.builtContainerfile).toBe('LIVE EDIT\n');
  });

  it('pins a clean git context to its commit through a subdirectory prefix', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { git: 'clean' });
    expect(result.status, result.output).toBe(0);
    expect(result.contextCommit).toMatch(/^[0-9a-f]{40}$/);
    const manifest = result.manifest as BuildContextManifest;
    expect(manifest.buildContext?.commit).toBe(result.contextCommit);
    expect(manifest.buildContext?.pinned).toBe(true);
    expect(result.builtContainerfile).toBe('FROM scratch\n# original fixture Containerfile\n');
  });

  // WI-10006045: the supply chain runs from the snapshot, which is not a git checkout, so it
  // cannot read the commit itself. Measured 2026-10-03: every pinned bake recorded provenance
  // sourceCheckout 'unknown' and the release trust gate refused it after the whole bake.
  it('hands the supply chain the pinned commit, since the snapshot it runs from is not a git checkout', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { git: 'clean' });
    expect(result.status, result.output).toBe(0);
    expect(result.contextCommit).toMatch(/^[0-9a-f]{40}$/);
    const args = result.supplyChainArgs ?? [];
    const at = args.indexOf('--source-commit');
    expect(at, args.join(' ')).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe(result.contextCommit);
    expect(args).not.toContain('--allow-unpinned-source');
  });

  it('marks an unpinned context as such to the supply chain instead of inventing a commit', () => {
    const result = runFixture(SOURCE);
    expect(result.status, result.output).toBe(0);
    const args = result.supplyChainArgs ?? [];
    expect(args, args.join(' ')).toContain('--allow-unpinned-source');
    expect(args).not.toContain('--source-commit');
  });

  it('refuses a context with an uncommitted file before anything is built', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { git: 'dirty' });
    expect(result.status).toBe(2);
    expect(result.output).toContain(`does not equal git commit ${result.contextCommit}`);
    expect(result.output).toContain('--allow-unpinned-context');
    expect(result.builtContainerfile).toBeNull();
    expect(result.podmanCalls.some((call) => call.startsWith('build '))).toBe(false);
    expect(result.files).not.toContain('supply-chain-ran');
  });

  it('bakes an uncommitted context only when asked, and records it as unpinned', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', {
      git: 'dirty',
      allowUnpinned: true,
    });
    expect(result.status, result.output).toBe(0);
    const manifest = result.manifest as BuildContextManifest;
    expect(manifest.buildContext?.commit).toBe(result.contextCommit);
    expect(manifest.buildContext?.pinned).toBe(false);
    expect(existsSync(join(result.out, 'build-context', 'papercusp-uncommitted.conf'))).toBe(true);
  });
});

const AUDITOR_HANDOFF_MARKER = "# The secret scan's release auditor lives OUTSIDE the build context";

/** The pre-WI-10005946 shape: the snapshot is taken but nobody tells the scan where the auditor is. */
function withoutAuditorHandoff(): string {
  const start = SOURCE.indexOf(AUDITOR_HANDOFF_MARKER);
  const endMarker = 'export PAPERCUSP_RELEASE_AUDITOR\n';
  const end = SOURCE.indexOf(endMarker, start);
  expect(start, 'auditor hand-off marker must be present in the shipped script').toBeGreaterThan(-1);
  expect(end, 'auditor hand-off block must end by exporting PAPERCUSP_RELEASE_AUDITOR').toBeGreaterThan(start);
  return SOURCE.slice(0, start) + SOURCE.slice(end + endMarker.length);
}

describe('bake-cloud-images.sh hands the secret scan its release auditor (WI-10005946)', () => {
  it('resolves the auditor from the source tree, not the snapshot, and the supply chain finds it', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { git: 'clean', auditor: 'source-tree' });
    expect(result.status, result.output).toBe(0);
    const expected = realpathSync(join(result.context, '..', '..', '..', 'papercusp-desktop', 'bin', 'audit-release-bundle.py'));
    expect(result.output).toContain(`BAKE_RELEASE_AUDITOR=${expected}`);
    expect(result.supplyChainAuditor).toBe(`found ${expected}`);
  });

  it('falsifiability control: without the hand-off the scan looks under the snapshot and misses', () => {
    // Measured 2026-10-03 09:58Z, chain4 try 2 bake A: the build finished, then the supply chain
    // refused with "release auditor not found: <out>/build-context/../../../papercusp-desktop/...".
    const result = runFixture(withoutAuditorHandoff(), 'raw', undefined, undefined, false, 'pass', {
      git: 'clean',
      auditor: 'source-tree',
    });
    expect(result.supplyChainAuditor).toMatch(
      /^missing .*\/build-context\/\.\.\/\.\.\/\.\.\/papercusp-desktop\/bin\/audit-release-bundle\.py$/,
    );
  });

  it('refuses before building when no auditor can be found', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { git: 'clean', auditor: 'missing' });
    expect(result.status).toBe(2);
    expect(result.output).toContain('release auditor not found');
    expect(result.builtContainerfile).toBeNull();
    expect(result.podmanCalls.some((call) => call.startsWith('build '))).toBe(false);
    expect(result.supplyChainAuditor).toBeNull();
  });

  it('honours an explicit PAPERCUSP_RELEASE_AUDITOR', () => {
    const result = runFixture(SOURCE);
    expect(result.status, result.output).toBe(0);
    expect(result.supplyChainAuditor).toMatch(/^found .*\/fixture-audit-release-bundle\.py$/);
  });
});

describe('p306 rootful Podman storage preflight (EI-22772454141611988)', () => {
  it.each([
    ['non-native overlay diff', 'false', false, 'private'],
    ['mount-program marker', 'true', true, 'private'],
    ['native overlay diff without marker', 'true', false, 'shared'],
  ] as const)('routes the %s shape before the first build', (_name, nativeOverlayDiff, marker, mode) => {
    const result = runImageBuildProbeStorageFixture(nativeOverlayDiff, marker);

    // The fake build deliberately fails immediately; the assertion is about
    // the storage boundary selected before any build can touch the store.
    expect(result.status).toBe(1);
    expect(result.output).toContain(`P306_STORAGE_MODE=${mode}`);
    expect(result.podmanCalls.some((call) => call.includes('build ')), result.output).toBe(true);

    const buildCall = result.podmanCalls.find((call) => call.includes('build '));
    expect(buildCall).toBeDefined();
    if (mode === 'private') {
      expect(buildCall).toMatch(/--root \/.*\/private-storage-parent\/p306-probe-storage\.[A-Za-z0-9]+/);
      expect(buildCall).toMatch(/--runroot \/.*\/private-run-parent\/p306-probe-run\.[A-Za-z0-9]+/);
    } else {
      expect(buildCall).not.toContain('--root ');
      expect(buildCall).not.toContain('--runroot ');
    }
  });
});

describe('bake-cloud-images.sh bounds its rootful podman storage (WI-10005960)', () => {
  it('prunes and prechecks headroom before building, and prunes again before PASS', () => {
    const result = runFixture(SOURCE);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('BAKE_RESULT=PASS');
    expect(result.hygieneCalls).toEqual([
      expect.stringMatching(/^prune --repo localhost\/test\/workspace-host --keep-tag \S+ build-started=0$/),
      expect.stringMatching(/^precheck \S+\/out build-started=0$/),
      expect.stringMatching(/^prune --repo localhost\/test\/workspace-host --keep-tag \S+ build-started=1$/),
    ]);
  });

  it('refuses a bake the disk cannot hold before anything is built', () => {
    const result = runFixture(SOURCE, 'raw', undefined, undefined, false, 'pass', { hygienePrecheck: 'fail' });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('BAKE_RESULT=FAILED storage-headroom');
    expect(result.output).not.toContain('BAKE_RESULT=PASS');
    expect(result.podmanCalls.some((call) => call.startsWith('build '))).toBe(false);
    expect(result.hygieneCalls).toHaveLength(2);
  });

  it('keeps a reused local source image in the same repo through the pre-build prune', () => {
    const result = runFixture(SOURCE, 'raw', undefined, { ref: 'localhost/test/workspace-host:previous-good' });
    expect(result.status, result.output).toBe(0);
    expect(result.hygieneCalls[0]).toMatch(/ --keep-tag \S+ --keep-tag previous-good build-started=0$/);
  });
});
