#!/usr/bin/env bash
# P-307 / D-253 / D-254 — the ONE bake path. Build the workspace-host bootc image once, sign and
# attest it once, then render it to every cloud's disk format from THAT ONE DIGEST.
#
# WHAT THIS REPLACES. `infra/images/workspace-host.pkr.hcl` declares exactly one Packer source
# (`googlecompute`), while `operator-core/lib/workspace-host/` carries three independent
# publishers (gcp-image-family, aws-ami-release, azure-compute-gallery-release). So "one image,
# three clouds" was one image on ONE cloud plus three registration paths that could drift with
# nothing to notice. This collapses the BAKE; the per-cloud PUBLISH adapters stay exactly as they
# are, because each cloud's image registry genuinely differs and D-253 keeps them.
#
# ⛔ THE PROPERTY THIS SCRIPT EXISTS TO ENFORCE — every cloud disk is rendered from the SAME
# image digest, and that is ASSERTED, not assumed. Handing `bootc-image-builder` a TAG three
# times is the obvious way to write this and it is silently wrong: a tag move between two
# invocations yields disks built from different content while all three exit 0 and the build log
# reads clean. That is D-288's orphaned-attestation defect one level up — same cause (a mutable
# reference resolved more than once), same signature (nothing errors), and the same repair
# (resolve the digest ONCE, from the registry, and pass `repo@sha256:…` everywhere after).
# `bake_one` therefore refuses any ref that is not digest-pinned.
#
# ⛔ AND THE SUPPLY CHAIN RUNS BEFORE ANY DISK IS CUT. release-supply-chain.sh was built by P-308
# and, until this script, was invoked by NOTHING — no release signed or attested. Rendering disks
# from an image that failed signing wastes the expensive half of the pipeline on bytes that must
# not ship, so the gate goes first and a failure there stops the bake.
#
# Usage:
#   bake-cloud-images.sh --registry <host[:port]/namespace> --key <cosign.key> [options]
#
#   --registry REF       registry namespace to publish the image to, e.g. reg.example.com/papercusp.
#                        ⚠ INCLUDE THE PORT if the registry uses one: it is part of the signature
#                        scope, and dropping it makes the host refuse its own release with a
#                        message byte-identical to "unsigned" (p307-registries-d-scope-probe.sh).
#   --key PATH           cosign private key; COSIGN_PASSWORD is read from the environment.
#   --pubkey PATH        matching public key (default: --key with .key replaced by .pub).
#   --tag TAG            image tag to publish (default: papercusp-workspace-host-<date>).
#   --clouds LIST        comma-separated subset of gcp,aws,azure (default: all three).
#   --out DIR            artifact directory (default: ./.bake-out).
#   --release-root DIR   extracted vm-release tree to bake into the optional P-305 image target.
#   --release-version V  version directory name for --release-root (both options are required
#                        together; omitting both preserves the P-306/P-307 OS-only image).
#   --source-image REF   reuse an already-verified local image instead of rebuilding it. The
#                        source is retagged and pushed, then the normal registry-digest,
#                        supply-chain and render gates still run. Mutually exclusive with the
#                        release-root options because those inputs are already baked into REF.
#   --insecure-registry  plain-HTTP / self-signed registry (local testing only).
#   --allow-unpinned-context
#                        bake from a build context that does not equal a git commit (uncommitted
#                        or untracked files in infra/images/bootc, or no git checkout at all). The
#                        snapshot and its content hash are still recorded; only the commit pin is
#                        waived, and the manifest says so (buildContext.pinned=false).
#   --dry-run            resolve and PLAN every step, run no build and no bake. Prints the same
#                        digest-pinned refs the real run would use.
#
# Exit: 0 all requested clouds rendered; 1 a step failed; 2 usage/setup error;
#       3 the supply-chain gate refused the image (nothing was baked).

# EI-22355025813361885 — freeze the entrypoint before Bash can lazily parse a
# compound body. A long bake must keep executing the bytes it passed at startup;
# an in-place editor can otherwise replace the inode while Bash is between the
# early setup commands and a later function body. Re-exec the validated copy so
# the mutable checkout is never the interpreter's live input.
if [ "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT:-0}" != "1" ] &&
   [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _BAKE_SOURCE_PATH="${BASH_SOURCE[0]}"
  _BAKE_SOURCE_DIR="$(cd "$(dirname "$_BAKE_SOURCE_PATH")" && pwd -P)" || {
    echo "FATAL: cannot resolve bake script directory: $_BAKE_SOURCE_PATH" >&2
    exit 2
  }
  _BAKE_SOURCE_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/papercusp-bake-cloud-images.XXXXXX.sh")" || {
    echo "FATAL: cannot create an immutable bake script snapshot" >&2
    exit 2
  }
  # The parent trap covers copy/validation failures. The re-exec'd child installs
  # its own trap because exec replaces this shell before an EXIT trap can run.
  trap 'rm -f -- "$_BAKE_SOURCE_SNAPSHOT"' EXIT
  if ! cp -- "$_BAKE_SOURCE_PATH" "$_BAKE_SOURCE_SNAPSHOT" ||
     ! bash -n -- "$_BAKE_SOURCE_SNAPSHOT"; then
    echo "FATAL: bake script snapshot is not a valid Bash program" >&2
    exit 2
  fi
  export PAPERCUSP_BAKE_SOURCE_SNAPSHOT=1
  export PAPERCUSP_BAKE_SOURCE_DIR="$_BAKE_SOURCE_DIR"
  export PAPERCUSP_BAKE_SOURCE_SNAPSHOT_PATH="$_BAKE_SOURCE_SNAPSHOT"
  exec bash "$_BAKE_SOURCE_SNAPSHOT" "$@" || exit 2
fi
if [ "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT:-0}" = "1" ]; then
  trap 'rm -f -- "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT_PATH:-}"' EXIT
fi

set -uo pipefail

if [ -n "${PAPERCUSP_BAKE_SOURCE_DIR:-}" ]; then
  HERE="$PAPERCUSP_BAKE_SOURCE_DIR"
else
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
BUILD_HEALTH="$HERE/p307-build-health.sh"

# bootc-image-builder's output type per cloud, and the disk file it produces. This table is the
# whole per-cloud surface of the bake — three rows instead of three pipelines.
declare -A CLOUD_TYPE=( [gcp]=gce      [aws]=ami       [azure]=vhd )
declare -A CLOUD_FILE=( [gcp]=image/disk.raw [aws]=image/disk.raw [azure]=vhd/disk.vhd )
declare -A CLOUD_SHA=() CLOUD_BYTES=()

REGISTRY=""; KEY=""; PUBKEY=""; TAG=""; CLOUDS="gcp,aws,azure"; OUT="./.bake-out"
RELEASE_ROOT=""; RELEASE_VERSION=""; SOURCE_IMAGE=""
INSECURE=0; DRY_RUN=0; ALLOW_UNPINNED_CONTEXT=0
BIB_IMG="${BOOTC_IMAGE_BUILDER:-quay.io/centos-bootc/bootc-image-builder:latest}"
SKOPEO_IMG="${SKOPEO_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"

die() { echo "FATAL: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="${2:-}"; shift 2;;
    --key) KEY="${2:-}"; shift 2;;
    --pubkey) PUBKEY="${2:-}"; shift 2;;
    --tag) TAG="${2:-}"; shift 2;;
    --clouds) CLOUDS="${2:-}"; shift 2;;
    --out) OUT="${2:-}"; shift 2;;
    --release-root) RELEASE_ROOT="${2:-}"; shift 2;;
    --release-version) RELEASE_VERSION="${2:-}"; shift 2;;
    --source-image) SOURCE_IMAGE="${2:-}"; shift 2;;
    --insecure-registry) INSECURE=1; shift;;
    --allow-unpinned-context) ALLOW_UNPINNED_CONTEXT=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '1,50p' "$0"; exit 0;;
    *) die "unknown argument '$1'";;
  esac
done

[ -n "$REGISTRY" ] || die "--registry is required"
[ "$DRY_RUN" -eq 1 ] || [ -n "$KEY" ] || die "--key is required (or use --dry-run)"
if [ -n "$RELEASE_ROOT" ] || [ -n "$RELEASE_VERSION" ]; then
  [ -n "$RELEASE_ROOT" ] && [ -n "$RELEASE_VERSION" ] \
    || die "--release-root and --release-version must be supplied together"
  [ -d "$RELEASE_ROOT" ] || die "--release-root is not a directory: $RELEASE_ROOT"
  RELEASE_ROOT="$(cd "$RELEASE_ROOT" && pwd -P)" \
    || die "cannot resolve --release-root: $RELEASE_ROOT"
  case "$RELEASE_VERSION" in
    [A-Za-z0-9]*) ;;
    *) die "--release-version must start with an alphanumeric";;
  esac
  case "$RELEASE_VERSION" in
    *[!A-Za-z0-9._+-]*) die "--release-version contains unsafe characters";;
  esac
  [ "${#RELEASE_VERSION}" -le 128 ] \
    || die "--release-version must be at most 128 characters"
fi
[ -z "$SOURCE_IMAGE" ] || { [ -z "$RELEASE_ROOT" ] && [ -z "$RELEASE_VERSION" ]; } \
  || die "--source-image is mutually exclusive with --release-root/--release-version"
case "$REGISTRY" in
  *' '*|*'<'*) die "--registry '$REGISTRY' is not a registry namespace";;
  */) die "--registry must not end in '/'";;
  *.*|*:*|localhost*) ;;
  *) die "--registry '$REGISTRY' has no registry host";;
esac
TAG="${TAG:-papercusp-workspace-host-$(date -u +%Y%m%d)}"
REPO="$REGISTRY/workspace-host"

# EI-25301484626869456: timestamped outputs identify attempts, not releases.
# Hold admission through process exit, including every child bake step.
if [ "$DRY_RUN" -eq 0 ] && [ -n "$RELEASE_VERSION" ]; then
  command -v flock >/dev/null 2>&1 || die "'flock' not found; cannot guard concurrent release bakes"
  BAKE_LOCK_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}/papercusp-bake-$UID}/papercusp-release-bakes"
  mkdir -p "$BAKE_LOCK_DIR" || die "cannot create release bake lock directory"
  exec {BAKE_RELEASE_LOCK}>"$BAKE_LOCK_DIR/$RELEASE_VERSION.lock" \
    || die "cannot open release bake lock"
  flock -n "$BAKE_RELEASE_LOCK" \
    || die "release bake already active: $RELEASE_VERSION (refusing duplicate)"
fi
# End release bake admission.

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi
TLS=(); [ "$INSECURE" -eq 1 ] && TLS=(--tls-verify=false)

# EI-22752400853032697 — bootc-image-builder creates host-visible loop
# partitions while it renders a disk. A desktop UDisks client can automount
# those partitions behind osbuild's back: the first root filesystem then stays
# mounted under /media, and the exporter phase fails when it mounts the copied
# filesystem with the same XFS UUID. Ubuntu/Debian ship this maintained helper
# specifically for installers; reuse it instead of open-coding a UDisks rule.
#
# The helper owns one global /run/udev rule, so serialize all callers around it.
# Without the lock, the first of two concurrent renders to exit removes the rule
# while the other is still creating loop partitions. Headless builders without
# UDisks keep the original direct Podman path.
UDISKS2_INHIBIT="${UDISKS2_INHIBIT_BIN:-}"
if [ -z "$UDISKS2_INHIBIT" ]; then
  for candidate in /usr/libexec/udisks2/udisks2-inhibit /usr/lib/udisks2/udisks2-inhibit; do
    if [ -x "$candidate" ]; then UDISKS2_INHIBIT="$candidate"; break; fi
  done
fi
UDISKS2_INHIBIT_LOCK="${PAPERCUSP_UDISKS2_INHIBIT_LOCK:-/run/lock/papercusp-bootc-bake-udisks2-inhibit.lock}"
case "$UDISKS2_INHIBIT_LOCK" in
  /*) ;;
  *) die "PAPERCUSP_UDISKS2_INHIBIT_LOCK must be an absolute path";;
esac
RENDER_PODMAN=("${PODMAN[@]}")
if [ -n "$UDISKS2_INHIBIT" ]; then
  command -v flock >/dev/null 2>&1 || die "'flock' not found; cannot serialize the UDisks inhibitor"
  if [ "$(id -u)" -eq 0 ]; then
    RENDER_PODMAN=(flock --wait 21600 "$UDISKS2_INHIBIT_LOCK" "$UDISKS2_INHIBIT" podman)
  else
    RENDER_PODMAN=(sudo -n flock --wait 21600 "$UDISKS2_INHIBIT_LOCK" "$UDISKS2_INHIBIT" podman)
  fi
  echo "BAKE_UDISKS2_INHIBIT=$UDISKS2_INHIBIT"
  echo "BAKE_UDISKS2_INHIBIT_LOCK=$UDISKS2_INHIBIT_LOCK"
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet udisks2.service 2>/dev/null; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY_RUN: WARNING udisks2 is active but udisks2-inhibit is unavailable — the real render would refuse"
  else
    die "udisks2 is active but udisks2-inhibit is unavailable; refusing an automount-racy disk render"
  fi
else
  echo "BAKE_UDISKS2_INHIBIT=not-required"
fi

# A specialised image must contain the public half of the key that signs it. Merely pointing
# policy.json at a future path produces a host that fails closed but can never upgrade, and the
# first real P-307 render proved that this path had never been populated. Resolve and validate it
# BEFORE the expensive build. The key is public; base64 is only a quoting-safe build-arg encoding.
if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$KEY" ] || die "private key not found: $KEY"
  [ -n "$PUBKEY" ] || PUBKEY="${KEY%.key}.pub"
  [ -f "$PUBKEY" ] || die "public key not found: $PUBKEY (pass --pubkey)"
  PUBKEY_B64="$(base64 -w0 < "$PUBKEY")"
  [ -n "$PUBKEY_B64" ] || die "public key is empty: $PUBKEY"
  STORAGE_DRIVER="${RELEASE_STORAGE_DRIVER:-$("${PODMAN[@]}" info --format '{{.Store.GraphDriverName}}' 2>/dev/null)}"
else
  PUBKEY_B64=""
  STORAGE_DRIVER="${RELEASE_STORAGE_DRIVER:-overlay}"
fi
case "$STORAGE_DRIVER" in
  ''|*[!A-Za-z0-9_-]*) die "could not determine a valid containers/storage graph driver";;
esac

mkdir -p "$OUT" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd)" || die "cannot resolve artifact directory"

# ── 0. Freeze the BUILD CONTEXT (WI-10005766) ─────────────────────────────────────────────────
# The startup snapshot above freezes this SCRIPT only. The image is built from "$HERE": the
# Containerfile and every file it COPYs, plus release-supply-chain.sh and the build-health helper.
# HERE is the live shared checkout, which other agents edit and git-sync rewrites during a bake that
# runs for an hour or more. So an edit landing mid-bake reached the image with nothing recording it,
# and two bakes launched back to back could differ in OS content. Copy the context ONCE, before
# anything reads it, point every later step at the copy, and record in bake-manifest.json what was
# copied: always a content hash, plus the git commit and whether the copy equals that commit's tree.
# A context that does not equal a commit is refused unless --allow-unpinned-context is passed.
#
# The hash covers each file's bytes, its path and its executable bit (the only mode bit git
# records), and each symlink's target. The same function hashes the committed tree, so "pinned" is
# a content comparison. It does not read `git status`, which could race a concurrent edit.
build_context_sha256() { # $1 directory
  ( cd "$1" || exit 1
    find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z |
      while IFS= read -r -d '' p; do
        if [ -L "$p" ]; then
          printf 'link %s -> %s\n' "$p" "$(readlink -- "$p")"
        else
          x=-; [ -x "$p" ] && x=x
          printf 'file %s %s %s\n' "$(sha256sum < "$p" | cut -d' ' -f1)" "$x" "$p"
        fi
      done
  ) | sha256sum | cut -d' ' -f1
}
HERE_REAL="$(cd "$HERE" && pwd -P)" || die "cannot resolve build context directory: $HERE"
OUT_REAL="$(cd "$OUT" && pwd -P)" || die "cannot resolve artifact directory: $OUT"
[ "$OUT_REAL" != "$HERE_REAL" ] || die "--out must not be the build context directory itself ($HERE_REAL)"
CONTEXT_EXCLUDE=()
case "$OUT_REAL" in "$HERE_REAL"/*) CONTEXT_EXCLUDE=(--exclude="./${OUT_REAL#"$HERE_REAL"/}");; esac
BUILD_CONTEXT="$OUT/build-context"
{ rm -rf -- "$BUILD_CONTEXT" && mkdir -p -- "$BUILD_CONTEXT"; } \
  || die "cannot create the build context snapshot directory: $BUILD_CONTEXT"
tar -C "$HERE_REAL" "${CONTEXT_EXCLUDE[@]}" -cf - . | tar -C "$BUILD_CONTEXT" -xpf - \
  || die "cannot snapshot build context $HERE_REAL into $BUILD_CONTEXT"
BUILD_CONTEXT_SHA256="$(build_context_sha256 "$BUILD_CONTEXT")"
case "$BUILD_CONTEXT_SHA256" in
  [0-9a-f][0-9a-f]*) [ "${#BUILD_CONTEXT_SHA256}" -eq 64 ] || die "build context hash is malformed";;
  *) die "cannot hash the build context snapshot";;
esac
BUILD_CONTEXT_COMMIT=""; BUILD_CONTEXT_PINNED=0
if git -C "$HERE_REAL" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BUILD_CONTEXT_COMMIT="$(GIT_OPTIONAL_LOCKS=0 git -C "$HERE_REAL" rev-parse --verify HEAD 2>/dev/null)" \
    || BUILD_CONTEXT_COMMIT=""
  ctx_prefix="$(git -C "$HERE_REAL" rev-parse --show-prefix 2>/dev/null)"
  # Archive from the TOP LEVEL: run inside a subdirectory, git archive also restricts the output
  # to that subdirectory WITHIN the tree-ish, so `<commit>:infra/images/bootc/` comes back empty.
  ctx_top="$(git -C "$HERE_REAL" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$BUILD_CONTEXT_COMMIT" ] && [ -n "$ctx_top" ]; then
    ctx_tree="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-bake-context-tree.XXXXXX")" \
      || die "cannot create a scratch directory for the committed build context"
    if GIT_OPTIONAL_LOCKS=0 git -C "$ctx_top" archive --format=tar "$BUILD_CONTEXT_COMMIT:$ctx_prefix" \
         | tar -C "$ctx_tree" -xpf - &&
       [ "$(build_context_sha256 "$ctx_tree")" = "$BUILD_CONTEXT_SHA256" ]; then
      BUILD_CONTEXT_PINNED=1
    fi
    rm -rf -- "$ctx_tree"
  fi
fi
if [ "$BUILD_CONTEXT_PINNED" -ne 1 ] && [ "$ALLOW_UNPINNED_CONTEXT" -ne 1 ]; then
  die "build context $HERE_REAL does not equal git commit ${BUILD_CONTEXT_COMMIT:-<none: not a git checkout>}: it has uncommitted, untracked or ignored files. Commit them, or pass --allow-unpinned-context to bake this exact snapshot anyway (sha256 $BUILD_CONTEXT_SHA256)"
fi
BUILD_CONTEXT_PINNED_JSON=false; [ "$BUILD_CONTEXT_PINNED" -eq 1 ] && BUILD_CONTEXT_PINNED_JSON=true
echo "BAKE_BUILD_CONTEXT=$BUILD_CONTEXT sha256=$BUILD_CONTEXT_SHA256 commit=${BUILD_CONTEXT_COMMIT:-none} pinned=$BUILD_CONTEXT_PINNED_JSON"
# The secret scan's release auditor lives OUTSIDE the build context (papercusp-desktop/bin), so
# image-secret-scan.sh cannot find it relative to the snapshot (WI-10005946: the first bake after
# the snapshot landed spent its whole build and then refused at the scan). Resolve it from the
# real source tree now, refuse in seconds if it is missing, and hand it down explicitly. It is not
# copied: the auditor locates its own repo-relative data files from its real path.
PAPERCUSP_RELEASE_AUDITOR="${PAPERCUSP_RELEASE_AUDITOR:-$HERE_REAL/../../../papercusp-desktop/bin/audit-release-bundle.py}"
if [ -f "$PAPERCUSP_RELEASE_AUDITOR" ]; then
  PAPERCUSP_RELEASE_AUDITOR="$(cd "$(dirname "$PAPERCUSP_RELEASE_AUDITOR")" && pwd -P)/$(basename "$PAPERCUSP_RELEASE_AUDITOR")"
  echo "BAKE_RELEASE_AUDITOR=$PAPERCUSP_RELEASE_AUDITOR"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: WARNING release auditor not found at $PAPERCUSP_RELEASE_AUDITOR — the real run would refuse before building"
else
  die "release auditor not found: $PAPERCUSP_RELEASE_AUDITOR. The supply chain's secret scan needs it; set PAPERCUSP_RELEASE_AUDITOR=/path/to/audit-release-bundle.py"
fi
export PAPERCUSP_RELEASE_AUDITOR
# The generic provider-policy guard also lives outside the snapshotted build context.
PAPERCUSP_BUNDLED_SECRET_POLICY_EVALUATOR="${PAPERCUSP_BUNDLED_SECRET_POLICY_EVALUATOR:-$HERE_REAL/../../../apps/operator/lib/release/bootc-image-release-request-cli.ts}"
PAPERCUSP_BUNDLED_SECRET_POLICY_RUNNER="${PAPERCUSP_BUNDLED_SECRET_POLICY_RUNNER:-$HERE_REAL/../../../node_modules/.bin/tsx}"
if [ "$DRY_RUN" -ne 1 ]; then
  [ -f "$PAPERCUSP_BUNDLED_SECRET_POLICY_EVALUATOR" ] || die "bundled secret policy evaluator missing before bake"
  [ -x "$PAPERCUSP_BUNDLED_SECRET_POLICY_RUNNER" ] || die "bundled secret policy runner missing before bake"
  [ -x "${GITLEAKS_BIN:-$(command -v gitleaks || true)}" ] || die "gitleaks missing before bake"
fi
export PAPERCUSP_BUNDLED_SECRET_POLICY_EVALUATOR PAPERCUSP_BUNDLED_SECRET_POLICY_RUNNER
# From here on every step reads the snapshot, never the live checkout.
HERE="$BUILD_CONTEXT"
BUILD_HEALTH="$HERE/p307-build-health.sh"
[ -x "$BUILD_HEALTH" ] || die "build health helper is missing or not executable: $BUILD_HEALTH"
# WI-10005960: bound the rootful podman storage this bake fills (graphroot on the ROOT disk) and
# refuse a bake the disk cannot hold. BAKE_STORAGE_HYGIENE overrides the helper (test seam).
STORAGE_HYGIENE="${BAKE_STORAGE_HYGIENE:-$HERE/bake-storage-hygiene.sh}"
storage_prune() {
  local keep=(--keep-tag "$TAG")
  # A reused local source image in this repo must survive the prune that runs before it is retagged.
  case "$SOURCE_IMAGE" in "$REPO":*) keep+=(--keep-tag "${SOURCE_IMAGE#"$REPO":}");; esac
  bash "$STORAGE_HYGIENE" prune --repo "$REPO" "${keep[@]}"
}

# Run one potentially long-lived rootful container operation while the companion
# detector samples its process tree and build log. The operation's own exit code
# remains authoritative: health findings are diagnostics, never an implicit
# timeout or a changed bake verdict. Keep stdout live with a separate tail while
# preserving the complete log for post-failure inspection.
run_monitored() { # $1 log path, remaining args are the command
  local log="$1" health_log="${1}.health" command_pid="" health_pid="" tail_pid="" rc
  shift
  : > "$log" || return 1
  : > "$health_log" || return 1
  "$@" >"$log" 2>&1 &
  command_pid=$!
  tail -n +1 -f "$log" &
  tail_pid=$!
  if [ "${P307_BUILD_HEALTH_DISABLE:-0}" != "1" ]; then
    bash "$BUILD_HEALTH" \
      --pid "$command_pid" \
      --log "$log" \
      --interval-sec "${P307_BUILD_HEALTH_INTERVAL_SEC:-15}" \
      --stalled-after-sec "${P307_BUILD_HEALTH_STALLED_AFTER_SEC:-120}" \
      >"$health_log" 2>&1 &
    health_pid=$!
  fi
  wait "$command_pid"
  rc=$?
  if [ -n "$tail_pid" ]; then
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
  fi
  if [ -n "$health_pid" ]; then
    kill "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
  fi
  if [ -s "$health_log" ]; then
    echo "P307_BUILD_HEALTH_LOG=$health_log"
    cat "$health_log"
  fi
  return "$rc"
}

# D-334 / EI-23087105300112185 — inspect the CONVERTED artifact, not merely
# the OCI merge view. A release directory that is introduced root:root:0755 in
# one image layer and corrected in a later metadata-only layer looks healthy to
# `podman run`, yet bootc/osbuild can commit the earlier header to the raw disk.
# This read-only probe runs after the GCE exporter has produced disk.raw but
# before the disk is hashed or admitted to bake-manifest.json (and therefore
# before any publisher can upload it).
verify_release_disk_metadata() (
  set -euo pipefail
  local disk="$1" version="$2" loopdev="" mount_dir="" mounted=0
  local root_part release_dir deployment_root metadata uid gid mode kind mode_value required_value
  local nftables_config host_prepare_unit
  local -a privilege=() root_parts=() release_dirs=()

  disk_fail() {
    echo "BAKE_RELEASE_DISK_METADATA=FAILED version=$version disk=$disk detail=$*" >&2
    exit 1
  }

  cleanup_release_disk_probe() {
    local rc=$?
    set +e
    if [ "$mounted" -eq 1 ] && [ -n "$mount_dir" ]; then
      "${privilege[@]}" umount "$mount_dir" >/dev/null 2>&1
    fi
    if [ -n "$loopdev" ]; then
      "${privilege[@]}" losetup --detach "$loopdev" >/dev/null 2>&1
    fi
    if [ -n "$mount_dir" ]; then rmdir "$mount_dir" >/dev/null 2>&1; fi
    exit "$rc"
  }
  trap cleanup_release_disk_probe EXIT

  [ -n "$version" ] || disk_fail 'release-version-empty'
  [ -s "$disk" ] && [ -f "$disk" ] && [ ! -L "$disk" ] \
    || disk_fail 'disk-missing-or-not-regular'
  for tool in losetup lsblk mount umount udevadm find stat readlink awk cat grep; do
    command -v "$tool" >/dev/null 2>&1 || disk_fail "tool-missing:$tool"
  done
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || disk_fail 'tool-missing:sudo'
    privilege=(sudo -n)
  fi

  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-release-disk.XXXXXX")" \
    || disk_fail 'mount-directory-create-failed'
  loopdev="$("${privilege[@]}" losetup --find --show --partscan --read-only "$disk")" \
    || disk_fail 'loop-attach-failed'
  [ -n "$loopdev" ] || disk_fail 'loop-device-empty'
  "${privilege[@]}" udevadm settle || disk_fail 'udev-settle-failed'

  mapfile -t root_parts < <(
    "${privilege[@]}" lsblk -nrpo PATH,FSTYPE,LABEL "$loopdev" \
      | awk '$2 == "xfs" && $3 == "root" { print $1 }'
  )
  [ "${#root_parts[@]}" -eq 1 ] \
    || disk_fail "expected-one-xfs-root-partition:found=${#root_parts[@]}"
  root_part="${root_parts[0]}"
  "${privilege[@]}" mount -o ro,norecovery,nouuid "$root_part" "$mount_dir" \
    || disk_fail 'root-mount-failed'
  mounted=1

  mapfile -t release_dirs < <(
    "${privilege[@]}" find "$mount_dir/ostree/deploy" \
      -path "*/deploy/*.0/opt/papercusp/releases/$version" -type d -print
  )
  [ "${#release_dirs[@]}" -eq 1 ] \
    || disk_fail "expected-one-active-release-directory:found=${#release_dirs[@]}"
  release_dir="${release_dirs[0]}"
  deployment_root="${release_dir%/opt/papercusp/releases/$version}"

  metadata="$("${privilege[@]}" stat -c '%u:%g:%a:%F' -- "$release_dir")" \
    || disk_fail 'release-directory-stat-failed'
  [ "$metadata" = '0:912:750:directory' ] \
    || disk_fail "release-directory-metadata:$metadata:expected=0:912:750:directory"

  assert_release_file() {
    local path="$1" label="$2" required="$3"
    metadata="$("${privilege[@]}" stat -c '%u:%g:%a:%F' -- "$path")" \
      || disk_fail "$label-stat-failed"
    IFS=: read -r uid gid mode kind <<<"$metadata"
    [ "$uid:$gid:$kind" = '0:912:regular file' ] \
      || disk_fail "$label-metadata:$metadata:expected-owner=0:912:regular-file"
    case "$mode" in
      ''|*[!0-7]*) disk_fail "$label-mode-not-octal:$mode";;
    esac
    mode_value=$((8#$mode))
    required_value=$((8#$required))
    (( (mode_value & required_value) == required_value )) \
      || disk_fail "$label-mode:$mode:required-bits=$required"
  }
  assert_release_file "$release_dir/serve.mjs" 'serve-mjs' 040
  assert_release_file "$release_dir/bin/node" 'node-runtime' 150

  metadata="$("${privilege[@]}" readlink -- "$deployment_root/opt/papercusp/current")" \
    || disk_fail 'current-symlink-read-failed'
  [ "$metadata" = "releases/$version" ] \
    || disk_fail "current-symlink-target:$metadata:expected=releases/$version"

  nftables_config="$deployment_root/etc/sysconfig/nftables.conf"
  metadata="$("${privilege[@]}" stat -c '%u:%g:%a:%F' -- "$nftables_config")" \
    || disk_fail 'nftables-config-stat-failed'
  [ "$metadata" = '0:0:600:regular file' ] \
    || disk_fail "nftables-config-metadata:$metadata:expected=0:0:600:regular-file"
  metadata="$("${privilege[@]}" cat -- "$nftables_config")" \
    || disk_fail 'nftables-config-read-failed'
  [ "$metadata" = 'include "/etc/nftables/papercusp-workspace-host.nft"' ] \
    || disk_fail "nftables-config-content:$metadata"
  "${privilege[@]}" grep -Fx 'table inet papercusp_workspace_host {' \
    "$deployment_root/etc/nftables/papercusp-workspace-host.nft" >/dev/null \
    || disk_fail 'nftables-ruleset-table-missing'

 host_prepare_unit="$deployment_root/usr/lib/systemd/system/papercusp-host-prepare.service"
  "${privilege[@]}" grep -Fx 'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service' "$host_prepare_unit" >/dev/null \
    || disk_fail 'host-prepare-nftables-requires-missing'
  "${privilege[@]}" grep -Fx 'After=local-fs.target systemd-tmpfiles-setup.service nftables.service' "$host_prepare_unit" >/dev/null \
    || disk_fail 'host-prepare-nftables-order-missing'
  [ "$("${privilege[@]}" readlink -- "$deployment_root/etc/systemd/system/multi-user.target.wants/nftables.service")" \
      = '/usr/lib/systemd/system/nftables.service' ] \
    || disk_fail 'nftables-enable-link-invalid'
  [ "$("${privilege[@]}" readlink -- "$deployment_root/etc/systemd/system/multi-user.target.wants/papercusp-host-prepare.service")" \
      = '/usr/lib/systemd/system/papercusp-host-prepare.service' ] \
    || disk_fail 'host-prepare-enable-link-invalid'

  echo "BAKE_RELEASE_DISK_METADATA=PASS version=$version disk=$disk release=$release_dir firewall=exact-and-ordered"
)

# Requested clouds are validated UP FRONT, before the expensive build. A typo'd cloud name that
# is only noticed in the render loop has already paid for a build and a supply-chain pass.
IFS=',' read -r -a WANT <<< "$CLOUDS"
[ "${#WANT[@]}" -gt 0 ] || die "--clouds selected nothing"
for c in "${WANT[@]}"; do
  [ -n "${CLOUD_TYPE[$c]:-}" ] || die "unknown cloud '$c' (known: ${!CLOUD_TYPE[*]})"
done

echo "BAKE_REPO=$REPO:$TAG"
echo "BAKE_CLOUDS=${WANT[*]}"

# ── 0. Preflight the SUPPLY-CHAIN toolchain, BEFORE the expensive half ────────────────────────
# release-supply-chain.sh resolves syft/grype off PATH and documents SYFT_BIN/GRYPE_BIN as the
# override seam — but nothing propagated them, and this script drives podman against ROOT
# storage, so it is invoked under sudo. sudo's secure_path DISCARDS a per-user ~/.local/bin,
# which is exactly where syft and grype install by default. Measured on the first end-to-end
# run: build, push, registry digest resolve, cosign sign and the provenance attest ALL
# succeeded, and the chain then died on "syft not found" — the expensive half spent for a
# binary that was knowably missing at second 0. Resolve them here and refuse before building.
#
# PATH wins. A release host installs these system-wide and never reaches the sudo branch.
resolve_tool() { # $1 tool name  $2 caller-supplied override
  local name="$1" override="${2-}" p="" home=""
  if [ -n "$override" ]; then printf '%s' "$override"; return 0; fi
  p="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$p" ] && [ -n "${SUDO_USER-}" ]; then
    home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    [ -n "$home" ] && [ -x "$home/.local/bin/$name" ] && p="$home/.local/bin/$name"
  fi
  printf '%s' "$p"
}

need_tool() { # $1 name  $2 resolved path
  local name="$1" path="${2-}" upper
  upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  if [ -n "$path" ] && [ -x "$path" ]; then
    echo "BAKE_TOOL_$upper=$path"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY_RUN: WARNING '$name' not found — the real run would refuse before building"
    return 0
  fi
  die "'$name' not found. The supply-chain gate runs BEFORE the bake and needs it; install it system-wide or pass ${upper}_BIN=/path/to/$name"
}

SYFT_RESOLVED="$(resolve_tool syft "${SYFT_BIN-}")"
GRYPE_RESOLVED="$(resolve_tool grype "${GRYPE_BIN-}")"
need_tool syft  "$SYFT_RESOLVED"
need_tool grype "$GRYPE_RESOLVED"
export SYFT_BIN="$SYFT_RESOLVED" GRYPE_BIN="$GRYPE_RESOLVED"

# ── 1. Establish the image ONCE ───────────────────────────────────────────────────────────────
# The registry namespace is substituted into policy.json + registries.d INSIDE the build (layer
# 3), all-or-nothing, so an image either names the real registry in both files or fails closed
# in both. Passing it here is what makes the built image able to verify its own upgrades.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would prune superseded $REPO images and require ${BAKE_MIN_FREE_GIB:-64}GiB free on podman's graphroot and $OUT"
else
  # Prune BEFORE measuring: a disk full of this bake's own superseded images is not a reason to refuse.
  [ -r "$STORAGE_HYGIENE" ] || die "storage hygiene helper is missing: $STORAGE_HYGIENE"
  storage_prune
  bash "$STORAGE_HYGIENE" precheck "$OUT" || exit 1 # it printed BAKE_RESULT=FAILED storage-headroom
fi
if [ -n "$SOURCE_IMAGE" ] && [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would require local source image=$SOURCE_IMAGE, retag it as $REPO:$TAG, and push it"
elif [ -n "$SOURCE_IMAGE" ]; then
  echo "### 1/4 reuse verified local image (no rebuild)"
  "${PODMAN[@]}" image exists "$SOURCE_IMAGE" \
    || { echo "BAKE_RESULT=FAILED source image absent from local storage: $SOURCE_IMAGE"; exit 1; }
  "${PODMAN[@]}" tag "$SOURCE_IMAGE" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED retag source image"; exit 1; }
  "${PODMAN[@]}" push "${TLS[@]}" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED push"; exit 1; }
elif [ "$DRY_RUN" -eq 1 ]; then
  if [ -n "$RELEASE_ROOT" ]; then
    echo "DRY_RUN: would include release root=$RELEASE_ROOT version=$RELEASE_VERSION via target=workspace-host-release"
  fi
  echo "DRY_RUN: would podman build with registry=$REGISTRY storage-driver=$STORAGE_DRIVER and the release public key -t $REPO:$TAG"
else
  echo "### 1/4 build (one image, all clouds)"
  build_args=(
    --build-arg "PAPERCUSP_VENDOR_REFRESH=$(date -u +%s%N)" \
    --build-arg "RELEASE_REGISTRY_NAMESPACE=$REGISTRY" \
    --build-arg "RELEASE_STORAGE_DRIVER=$STORAGE_DRIVER" \
    --build-arg "RELEASE_SIGNING_PUBKEY_B64=$PUBKEY_B64" \
    -f "$HERE/workspace-host.Containerfile" -t "$REPO:$TAG"
  )
  if [ -n "$RELEASE_ROOT" ]; then
    build_args+=(
      --target workspace-host-release
      --build-context "papercusp-release=$RELEASE_ROOT"
      --build-arg "PAPERCUSP_RELEASE_VERSION=$RELEASE_VERSION"
    )
  fi
  build_args+=("$HERE")
  run_monitored "$OUT/image-build.log" "${PODMAN[@]}" build "${build_args[@]}"
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    echo "BAKE_RESULT=FAILED build"
    exit 1
  fi
  "${PODMAN[@]}" push "${TLS[@]}" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED push"; exit 1; }
fi

# ── 2. Resolve the digest from the REGISTRY, once ─────────────────────────────────────────────
# From the registry, never `podman image inspect`: a local RepoDigests value was measured
# resolving to a DIFFERENT repository's entry (D-287), and everything downstream — the signature,
# the attestation, and all three disks — is bound to whatever this returns.
if [ "$DRY_RUN" -eq 1 ]; then
  DIGEST="sha256:${DRY_RUN_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
  echo "DRY_RUN: would resolve $REPO:$TAG from the registry"
else
  echo "### 2/4 resolve digest from the registry"
  DIGEST="$("${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$SKOPEO_IMG" \
    inspect $([ "$INSECURE" -eq 1 ] && echo --tls-verify=false) \
    --format '{{.Digest}}' "docker://$REPO:$TAG" 2>/dev/null)"
fi
case "$DIGEST" in
  sha256:*) ;;
  *) echo "BAKE_RESULT=FAILED no registry digest for $REPO:$TAG"; exit 1;;
esac
PINNED="$REPO@$DIGEST"
echo "BAKE_DIGEST=$DIGEST"
echo "BAKE_PINNED_REF=$PINNED"

# ── 3. Supply chain BEFORE any disk is cut ────────────────────────────────────────────────────
# P-308's release-supply-chain.sh: sign -> SLSA provenance attest -> SBOM -> grype -> attest the
# SBOM -> VERIFY EVERY ARTIFACT BACK OUT OF THE REGISTRY. Until this call existed it was invoked
# by nothing, so no release was signed or attested at all.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would run release-supply-chain.sh --image $PINNED"
else
  echo "### 3/4 supply chain (sign, attest, SBOM, scan, verify-back)"
  sc_args=(--image "$PINNED" --key "$KEY" --pubkey "$PUBKEY" --out "$OUT/supply-chain" --fail-on-vulns)
  [ "$INSECURE" -eq 1 ] && sc_args+=(--insecure-registry)
  # The supply chain runs from the build-context SNAPSHOT ($HERE), which is not a git checkout,
  # so it cannot read the commit itself; hand it the commit the snapshot was verified equal to.
  # An unpinned context has no such commit and its provenance says so (WI-10006045).
  if [ "$BUILD_CONTEXT_PINNED" -eq 1 ]; then
    sc_args+=(--source-commit "$BUILD_CONTEXT_COMMIT")
  else
    sc_args+=(--allow-unpinned-source)
  fi
  bash "$HERE/release-supply-chain.sh" "${sc_args[@]}"
  sc_rc=$?
  if [ "$sc_rc" -ne 0 ]; then
    echo "BAKE_RESULT=REFUSED supply chain exited $sc_rc — nothing was baked"
    exit 3
  fi
fi

# ── 3b. Make the PINNED DIGEST resolvable in LOCAL storage ────────────────────────────────────
# bake_one hands bootc-image-builder `--local`, which reads ONLY local container storage, while
# the digest everything is pinned to was resolved from the REGISTRY. Those two do not have to
# agree, and measured on this box they did not: after `podman push`, local storage recorded
# RepoDigest sha256:1908e66d… while the registry served sha256:bf60322b… for that same tag, so
# `podman image exists <repo>@<registry digest>` was FALSE while the tag resolved fine (probe
# positive-controlled against the tag and against the local digest, so this is a real divergence
# and not a broken lookup). bib would then fail to find an image we had just built and pushed.
#
# Pull the pinned digest BACK so local storage provably holds exactly the bytes that were
# signed, then ASSERT it — an unresolvable ref must not reach bib as a vague "image not found".
if [ "$DRY_RUN" -eq 0 ]; then
  echo "### 3b/4 materialise $PINNED into local storage"
  "${PODMAN[@]}" pull "${TLS[@]}" "$PINNED" >/dev/null 2>&1 || true
  "${PODMAN[@]}" image exists "$PINNED" || {
    echo "BAKE_RESULT=FAILED $PINNED absent from local storage; bootc-image-builder --local cannot render it"
    exit 1
  }
fi

# ── 3c. Read back the release the IMAGE carries (WI-10005761) ─────────────────────────────────
# On the bootc model a release is image CONTENT: the bootstrap never installs one, it requires
# /opt/papercusp/releases/<version> to already be in the booted image. So bake-manifest.json
# records the release read out of the pinned image itself, never restated from --release-version:
# a --source-image reuse carries whatever its REF was built with, and only the image can say what
# that is. Release consumers (bootc-image-release-request-cli, the release gate) refuse a release
# the manifest does not record. That check was missing, and an OS-only bake paired with a release
# cost two billable clean rooms that booted, passed harden-os, then died at install-runtime.
IMAGE_RELEASE=""
if [ "$DRY_RUN" -eq 1 ]; then
  IMAGE_RELEASE="$RELEASE_VERSION"
  echo "DRY_RUN: would read the baked release from /opt/papercusp/current in $PINNED"
else
  echo "### 3c/4 read back the release the image carries"
  # Every branch prints a verdict line, so an empty answer is a failed probe, never "OS-only".
  release_probe='if [ -L /opt/papercusp/current ]; then t="$(readlink /opt/papercusp/current)"; case "$t" in releases/*) if [ -d "/opt/papercusp/$t" ]; then printf "PAPERCUSP_IMAGE_RELEASE=%s\n" "${t#releases/}"; else printf "PAPERCUSP_IMAGE_RELEASE_INVALID=dangling:%s\n" "$t"; fi;; *) printf "PAPERCUSP_IMAGE_RELEASE_INVALID=target:%s\n" "$t";; esac; elif [ -e /opt/papercusp/current ]; then echo PAPERCUSP_IMAGE_RELEASE_INVALID=not-a-symlink; else echo PAPERCUSP_IMAGE_RELEASE_NONE=1; fi'
  release_probe_out="$("${PODMAN[@]}" run --rm --pull=never --network=none --entrypoint /bin/sh "$PINNED" -c "$release_probe" 2>&1)"
  release_probe_rc=$?
  if [ "$release_probe_rc" -ne 0 ]; then
    echo "BAKE_RESULT=FAILED could not read the release $PINNED carries (podman exit $release_probe_rc): $release_probe_out"
    exit 1
  fi
  case "$release_probe_out" in
    *PAPERCUSP_IMAGE_RELEASE_INVALID=*)
      echo "BAKE_RESULT=FAILED $PINNED has an unusable /opt/papercusp/current: $release_probe_out"
      exit 1;;
    *PAPERCUSP_IMAGE_RELEASE_NONE=1*) IMAGE_RELEASE="";;
    *PAPERCUSP_IMAGE_RELEASE=*)
      IMAGE_RELEASE="$(printf '%s\n' "$release_probe_out" | sed -n 's/^PAPERCUSP_IMAGE_RELEASE=//p' | tail -n 1)";;
    *)
      echo "BAKE_RESULT=FAILED the release probe on $PINNED gave no verdict: ${release_probe_out:-<empty>}"
      exit 1;;
  esac
  # The same charset the Containerfile enforces; it is also what keeps the manifest JSON well-formed.
  case "$IMAGE_RELEASE" in
    '') ;;
    [A-Za-z0-9]*)
      case "$IMAGE_RELEASE" in *[!A-Za-z0-9._+-]*)
        echo "BAKE_RESULT=FAILED the image carries an unsafe release name: $IMAGE_RELEASE"; exit 1;;
      esac
      [ "${#IMAGE_RELEASE}" -le 128 ] \
        || { echo "BAKE_RESULT=FAILED the image release name is longer than 128 characters"; exit 1; };;
    *) echo "BAKE_RESULT=FAILED the image carries an unsafe release name: $IMAGE_RELEASE"; exit 1;;
  esac
fi
if [ -n "$RELEASE_VERSION" ] && [ "$IMAGE_RELEASE" != "$RELEASE_VERSION" ]; then
  echo "BAKE_RESULT=FAILED --release-version $RELEASE_VERSION, but the built image carries ${IMAGE_RELEASE:-no release}"
  exit 1
fi
echo "BAKE_IMAGE_RELEASE=${IMAGE_RELEASE:-none}"

# ── 3d. Load every native addon the release ships, in the image's own runtime (WI-10005910) ───
# The release is built on a newer userland than an older bootc base can supply. On
# centos-bootc:stream9 (libstdc++ 11.5, glibc 2.34) rocksdb-native needs GLIBCXX_3.4.30, so the
# image built, signed, rendered, published and booted, and the workspace service then died on the
# host roughly an hour later (P-012 clean room A, chain3). Nothing earlier in the bake runs the
# release, so this is the first point the mismatch can be seen: dlopen each addon with the
# release's own node, inside the pinned image, with no network. A foreign-platform prebuild
# (darwin-*, win32-*, *-musl, ...) is reported and skipped; anything else that fails to load fails
# the bake. A probe that loaded nothing measured nothing, so zero loaded addons also fails.
ADDON_PROBE_JS=""
IFS= read -r -d '' ADDON_PROBE_JS <<'JS'
// PAPERCUSP_ADDON_PROBE (WI-10005910): argv[1] is the release root.
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const here = process.platform + "-" + process.arch;
const PLATFORMS = /^(aix|android|darwin|freebsd|linux|openbsd|sunos|win32)$/;
const ARCHES = /^(arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)$/;
function foreign(rel) {
  const seg = rel.toLowerCase().split(path.sep);
  for (let i = 0; i < seg.length; i++) {
    if (/(^|[-_.])musl([-_.]|$)/.test(seg[i])) return true;
    const m = /^([a-z0-9]+)-([a-z0-9]+)(-|$)/.exec(seg[i]);
    if (m && PLATFORMS.test(m[1]) && ARCHES.test(m[2]) && m[1] + "-" + m[2] !== here) return true;
    if (PLATFORMS.test(seg[i]) && i + 1 < seg.length && ARCHES.test(seg[i + 1])
      && seg[i] + "-" + seg[i + 1] !== here) return true;
  }
  return false;
}
let ok = 0, fail = 0, skipped = 0;
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { fail++; console.log("PAPERCUSP_ADDON_FAIL " + dir + " :: unreadable: " + e.message); return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile() || !e.name.endsWith(".node")) continue;
    const rel = path.relative(root, p);
    if (foreign(rel)) { skipped++; console.log("PAPERCUSP_ADDON_SKIP " + rel); continue; }
    try { process.dlopen({ exports: {} }, p); ok++; }
    catch (x) { fail++; console.log("PAPERCUSP_ADDON_FAIL " + rel + " :: " + String(x && x.message).split("\n")[0]); }
  }
}
walk(root);
console.log("PAPERCUSP_ADDON_PROBE ok=" + ok + " fail=" + fail + " skipped=" + skipped);
JS
if [ -n "$IMAGE_RELEASE" ] && [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would load every native addon under /opt/papercusp/releases/$IMAGE_RELEASE in $PINNED"
elif [ -n "$IMAGE_RELEASE" ]; then
  echo "### 3d/4 load every native addon the release ships, in the image's own runtime"
  release_dir="/opt/papercusp/releases/$IMAGE_RELEASE"
  addon_probe_out="$("${PODMAN[@]}" run --rm --pull=never --network=none \
    --entrypoint "$release_dir/bin/node" "$PINNED" -e "$ADDON_PROBE_JS" "$release_dir" 2>&1)"
  addon_probe_rc=$?
  addon_ok=""; addon_fail=""; addon_skipped=""
  for kv in $(printf '%s\n' "$addon_probe_out" | sed -n 's/^PAPERCUSP_ADDON_PROBE //p' | tail -n 1); do
    case "$kv" in
      ok=*) addon_ok="${kv#ok=}";;
      fail=*) addon_fail="${kv#fail=}";;
      skipped=*) addon_skipped="${kv#skipped=}";;
    esac
  done
  printf '%s\n' "$addon_probe_out" | grep -E '^PAPERCUSP_ADDON_(FAIL|SKIP) ' | sed 's/^/  /'
  if [ "$addon_probe_rc" -ne 0 ]; then
    echo "BAKE_RESULT=FAILED the native-addon probe could not run in $PINNED (podman exit $addon_probe_rc): $(printf '%s\n' "$addon_probe_out" | tail -n 3)"
    exit 1
  fi
  case "$addon_ok:$addon_fail:$addon_skipped" in
    *[!0-9:]*|:*|*::*|*:)
      echo "BAKE_RESULT=FAILED the native-addon probe on $PINNED gave no verdict: ${addon_probe_out:-<empty>}"
      exit 1;;
  esac
  if [ "$addon_fail" -gt 0 ]; then
    echo "BAKE_RESULT=FAILED $addon_fail native addon(s) in release $IMAGE_RELEASE do not load on this image's runtime (see PAPERCUSP_ADDON_FAIL above)"
    exit 1
  fi
  if [ "$addon_ok" -eq 0 ]; then
    echo "BAKE_RESULT=FAILED the native-addon probe loaded no addon under $release_dir; it measured nothing"
    exit 1
  fi
  echo "BAKE_NATIVE_ADDONS=ok:$addon_ok skipped:$addon_skipped"
fi

# ── 4. Render each cloud from the SAME pinned digest ──────────────────────────────────────────
bake_one() { # $1 cloud  $2 pinned ref
  local cloud="$1" ref="$2" type="${CLOUD_TYPE[$1]}" dest="$OUT/$1"
  # The guard that makes the one-digest property real rather than intended. Every caller today
  # passes $PINNED; this refuses the future edit that "simplifies" it back to a tag.
  case "$ref" in
    *@sha256:*) ;;
    *) echo "  $cloud: REFUSED — '$ref' is not digest-pinned; a tag can move between renders"
       return 1;;
  esac
  mkdir -p "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  $cloud: DRY_RUN would render --type $type from $ref -> $dest/${CLOUD_FILE[$cloud]}"
    CLOUD_SHA[$cloud]="$(printf '0%.0s' {1..64})"
    CLOUD_BYTES[$cloud]=0
    return 0
  fi
  # Output belongs to one render. Refuse an earlier disk/archive so an exit-0
  # renderer that emits nothing cannot accidentally validate stale artifacts.
  if [ -e "$dest/${CLOUD_FILE[$cloud]}" ] || [ -e "$dest/gce/image.tar.gz" ]; then
    echo "  $cloud: REFUSED — output already contains an artifact; use a fresh --out directory"
    return 1
  fi
  # No `-it`: this runs unattended from the release pipeline and from probes, where there is no
  # TTY and `-t` fails outright.
  run_monitored "$dest/build.log" "${RENDER_PODMAN[@]}" run --rm --privileged --pull=newer \
    --security-opt label=type:unconfined_t \
    -v "$dest":/output -v /var/lib/containers/storage:/var/lib/containers/storage \
    "$BIB_IMG" --type "$type" --local "$ref"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  $cloud: FAILED (exit $rc) — see $dest/build.log"
    return 1
  fi
  # The GCE exporter writes gce/image.tar.gz with a sparse disk.raw member.
  # Normalize only that member to the raw path consumed by the publish adapter.
  if [ "$cloud" = gcp ] && [ -s "$dest/gce/image.tar.gz" ]; then
    mkdir -p "$dest/image" || return 1
    tar --extract --gzip --sparse --file "$dest/gce/image.tar.gz" \
      --directory "$dest/image" --no-same-owner --no-same-permissions -- disk.raw || {
      echo "  $cloud: FAILED — GCE archive did not yield disk.raw"
      return 1
    }
  fi
  # An exit 0 from a renderer that wrote nothing is the empty-SBOM defect in another costume:
  # a confident success whose artifact does not exist. Assert the disk before believing it.
  if [ ! -s "$dest/${CLOUD_FILE[$cloud]}" ] || [ ! -f "$dest/${CLOUD_FILE[$cloud]}" ] \
    || [ -L "$dest/${CLOUD_FILE[$cloud]}" ]; then
    echo "  $cloud: FAILED — exited 0 but produced no disk at ${CLOUD_FILE[$cloud]}"
    return 1
  fi
  # Every RAW disk that carries a release (gcp and aws; WI-10005761 found the aws disk was never
  # checked). The azure VHD is not loop-mounted here.
  if [ -n "$IMAGE_RELEASE" ] && [ "${CLOUD_FILE[$cloud]##*.}" = raw ]; then
    verify_release_disk_metadata "$dest/${CLOUD_FILE[$cloud]}" "$IMAGE_RELEASE" || {
      echo "  $cloud: FAILED — converted disk did not preserve the immutable release metadata"
      return 1
    }
  fi
  CLOUD_BYTES[$cloud]="$(stat -c%s "$dest/${CLOUD_FILE[$cloud]}")"
  CLOUD_SHA[$cloud]="$(sha256sum "$dest/${CLOUD_FILE[$cloud]}" | cut -d' ' -f1)"
  echo "  $cloud: ok (${CLOUD_BYTES[$cloud]} bytes; sha256:${CLOUD_SHA[$cloud]})"
  return 0
}

echo "### 4/4 render ${#WANT[@]} cloud image(s) from $DIGEST"
failed=0; rendered=()
for c in "${WANT[@]}"; do
  if bake_one "$c" "$PINNED"; then rendered+=("$c"); else failed=1; fi
done

# A manifest is an admission artifact, not a progress report. Never emit one for
# a partial/failed render: an empty `clouds` array is syntactically valid and can
# otherwise outlive the non-zero process status that was meant to disqualify it.
if [ "$failed" -ne 0 ] || [ "${#rendered[@]}" -ne "${#WANT[@]}" ]; then
  echo "BAKE_RENDERED=${rendered[*]:-none}"
  echo "BAKE_RESULT=FAILED"
  exit 1
fi

# The bake manifest the per-cloud PUBLISH adapters consume. It names ONE digest for every cloud,
# which is what lets a publisher verify it is registering the same bytes its siblings registered
# instead of taking that on faith.
{
  echo "{"
  echo "  \"contractVersion\": \"papercusp-bootc-bake-v1\","
  echo "  \"image\": \"$REPO\","
  echo "  \"tag\": \"$TAG\","
  echo "  \"digest\": \"$DIGEST\","
  echo "  \"pinnedRef\": \"$PINNED\","
  echo "  \"registryNamespace\": \"$REGISTRY\","
  echo "  \"dryRun\": $( [ "$DRY_RUN" -eq 1 ] && echo true || echo false ),"
  # Read back from the image in step 3c (WI-10005761); null = OS-only.
  if [ -n "$IMAGE_RELEASE" ]; then
    echo "  \"release\": {\"version\": \"$IMAGE_RELEASE\"},"
  else
    echo "  \"release\": null,"
  fi
  # WI-10005766: what the image was built from. commit is HEAD at bake start (null outside git);
  # pinned says whether the snapshot equals that commit's tree.
  if [ -n "$BUILD_CONTEXT_COMMIT" ]; then ctx_commit_json="\"$BUILD_CONTEXT_COMMIT\""; else ctx_commit_json=null; fi
  echo "  \"buildContext\": {\"sha256\": \"$BUILD_CONTEXT_SHA256\", \"commit\": $ctx_commit_json, \"pinned\": $BUILD_CONTEXT_PINNED_JSON},"
  printf '  "clouds": ['
  for i in "${!rendered[@]}"; do
    [ "$i" -gt 0 ] && printf ', '
    printf '{"cloud":"%s","type":"%s","artifact":"%s","sha256":"%s","sizeBytes":%s}' \
      "${rendered[$i]}" "${CLOUD_TYPE[${rendered[$i]}]}" "$OUT/${rendered[$i]}/${CLOUD_FILE[${rendered[$i]}]}" \
      "${CLOUD_SHA[${rendered[$i]}]}" "${CLOUD_BYTES[${rendered[$i]}]}"
  done
  echo "]"
  echo "}"
} > "$OUT/bake-manifest.json"

echo "BAKE_MANIFEST=$OUT/bake-manifest.json"
echo "BAKE_RENDERED=${rendered[*]:-none}"
# The pushed image now lives in the registry; drop what this bake superseded (never fails the bake).
[ "$DRY_RUN" -eq 1 ] || storage_prune
echo "BAKE_RESULT=PASS"
exit 0
