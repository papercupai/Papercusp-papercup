#!/usr/bin/env bash
# P-308 — the release supply-chain step for the bootc workspace-host image.
#
# This is the CALLABLE step, not a probe. P-307's `bootc-image-builder` pipeline invokes it after
# it has built and pushed an image; it signs, attests and scans that image, then VERIFIES its own
# work back out of the registry before reporting success. The probes beside it
# (p308-cosign-policy-interop-probe.sh, p308-cosign-attest-digest-probe.sh, p308-sbom-scan-probe.sh)
# prove the mechanism; this is the mechanism in the pipeline.
#
# It encodes the rulings rather than restating them, so they cannot be forgotten at a call site:
#
#   D-288  DIGEST, NEVER A TAG. A tag reference is resolved to a digest FIRST, from the REGISTRY,
#          and every cosign call is passed `repo@sha256:…`. Attesting a tag binds the attestation
#          to whatever digest the tag named at that instant; the next tag move orphans it, and the
#          resulting verification failure is byte-identical to "never attested". Measured.
#   D-287  The digest comes from the REGISTRY (skopeo), never `podman image inspect` — a local
#          RepoDigests value was measured resolving to a DIFFERENT repository's entry, and cosign
#          signed an object the registry does not hold.
#   D-249  KEY-BASED, `--tlog-upload=false`. Keyless cosign records signer identity in Rekor,
#          which is wrong for air-gapped use. No transparency log is contacted.
#   D-289  Never emit a bare vulnerability count as a verdict. The gate is scoped to
#          Critical/High WITH A FIX, because that is the only population a rebase can act on.
#
# VERIFY-AFTER-WRITE is the load-bearing habit here: every signature and attestation is read back
# out of the registry by digest before this script exits 0. A cosign command exiting 0 means it
# uploaded something; it does not mean a puller can verify it. Those came apart twice during
# P-308 (a missing `use-sigstore-attachments`, and an unsatisfiable `signedIdentity`), each time
# producing a green build over an artifact no host would accept.
#
# Usage:
#   release-supply-chain.sh --image <repo[:tag|@digest]> --key <cosign.key> [options]
#
#   --image REF          image to sign/attest/scan. A tag is accepted and resolved to a digest.
#   --key PATH           cosign private key (COSIGN_PASSWORD is read from the environment).
#   --pubkey PATH        public key for verify-back (default: --key with .key -> .pub).
#   --out DIR            artifact directory (default: ./.supply-chain-out).
#   --insecure-registry  plain-HTTP / self-signed registry (local testing only).
#   --fail-on-vulns      exit non-zero when Critical/High-with-a-fix is non-empty (default: report).
#   --skip-scan          sign + attest provenance only; no SBOM, no grype.
#   --skip-secret-scan   do not run image-secret-scan.sh before signing (SECRET_SCAN_BIN overrides
#                        the scanner). The release gate fails closed without its record, so a
#                        skipped image cannot be released.
#   --min-packages N     refuse an SBOM with fewer than N packages (default 50). This is the
#                        "the scanner read nothing" guard: an empty SBOM yields an empty CVE list,
#                        which is indistinguishable from a clean image. 50 suits a full OS image;
#                        lower it deliberately for a genuinely minimal target, never to get past
#                        a refusal you have not explained.
#   --source-commit SHA  the git commit the image was built from, recorded as the SLSA provenance
#                        sourceCheckout. Required when this script runs outside a git checkout (the
#                        bake runs it from its build-context snapshot, which is not one); otherwise
#                        it is read from the checkout this script lives in. A run with no
#                        resolvable commit refuses BEFORE signing (exit 2): the release trust gate
#                        refuses any provenance whose sourceCheckout is not a commit id (WI-10006045).
#   --allow-unpinned-source
#                        record sourceCheckout "unpinned" instead of refusing (an unpinned local
#                        test bake). The release trust gate still refuses such an image.
#   --containerfile PATH --build-type URI --builder-id URI --base-image REF
#                        Bind the existing signing pipeline to another OCI producer, such as the
#                        portable Server, without recording bootc provenance for different bytes.
#   --min-available-packages N
#                        D-027 positive control (default 1000, env VENDOR_MIN_AVAILABLE_PACKAGES):
#                        the in-image `dnf check-update` only counts as "the vendor ships nothing
#                        newer" when dnf could see at least N available packages. A dnf with no
#                        repos also exits 0, and must never make a finding vendor-pending.
#
# Exit: 0 all steps succeeded AND verified back; 1 a step or its verification failed;
#       2 usage/setup error; 3 the vulnerability gate refused the image (--fail-on-vulns);
#       4 the secret scan found findings, so nothing was signed.

set -uo pipefail

IMAGE=""; KEY=""; PUBKEY=""; OUTDIR="./.supply-chain-out"
INSECURE=0; FAIL_ON_VULNS=0; SKIP_SCAN=0; SKIP_SECRET_SCAN=0; MIN_PKGS=50
SOURCE_COMMIT=""; ALLOW_UNPINNED_SOURCE=0
CONTAINERFILE="infra/images/bootc/workspace-host.Containerfile"
BUILD_TYPE="https://papercusp.dev/bootc/workspace-host/v1"
BUILDER_ID="https://papercusp.dev/builders/bootc-image-builder"
BASE_IMG=""
MIN_AVAILABLE_PACKAGES="${VENDOR_MIN_AVAILABLE_PACKAGES:-1000}"

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2;;
    --key) KEY="${2:-}"; shift 2;;
    --pubkey) PUBKEY="${2:-}"; shift 2;;
    --out) OUTDIR="${2:-}"; shift 2;;
    --insecure-registry) INSECURE=1; shift;;
    --fail-on-vulns) FAIL_ON_VULNS=1; shift;;
    --skip-scan) SKIP_SCAN=1; shift;;
    --skip-secret-scan) SKIP_SECRET_SCAN=1; shift;;
    --min-packages) MIN_PKGS="${2:-50}"; shift 2;;
    --min-available-packages) MIN_AVAILABLE_PACKAGES="${2:-1000}"; shift 2;;
    --source-commit) SOURCE_COMMIT="${2:-}"; shift 2;;
    --allow-unpinned-source) ALLOW_UNPINNED_SOURCE=1; shift;;
    --containerfile) CONTAINERFILE="${2:-}"; shift 2;;
    --build-type) BUILD_TYPE="${2:-}"; shift 2;;
    --builder-id) BUILDER_ID="${2:-}"; shift 2;;
    --base-image) BASE_IMG="${2:-}"; shift 2;;
    -h|--help) sed -n '2,54p' "$0"; exit 0;;
    *) echo "usage error: unknown argument $1" >&2; exit 2;;
  esac
done

[ -n "$IMAGE" ] || { echo "usage error: --image is required" >&2; exit 2; }
[ -n "$KEY" ]   || { echo "usage error: --key is required" >&2; exit 2; }
[ -f "$KEY" ]   || { echo "usage error: key not found: $KEY" >&2; exit 2; }
[ -n "$PUBKEY" ] || PUBKEY="${KEY%.key}.pub"
[ -f "$PUBKEY" ] || { echo "usage error: public key not found: $PUBKEY (pass --pubkey)" >&2; exit 2; }
[[ "$CONTAINERFILE" =~ ^[a-zA-Z0-9_./-]+$ && "$CONTAINERFILE" != /* && "$CONTAINERFILE" != *..* ]] \
  || { echo "usage error: --containerfile must be a repository-relative path" >&2; exit 2; }
[[ "$BUILD_TYPE" == https://* && "$BUILDER_ID" == https://* ]] \
  || { echo "usage error: build type and builder id must be HTTPS URIs" >&2; exit 2; }

# The commit the image was built from, for the SLSA provenance sourceCheckout. Resolved and
# validated HERE, before anything is scanned or signed: the bake runs this script from its
# build-context snapshot, which is not a git checkout, and a `git rev-parse` there used to fall
# back to the literal "unknown" — which the release trust gate refuses, but only after the whole
# bake (WI-10006045). An explicit --source-commit wins; otherwise the checkout this script lives in.
if [ -z "$SOURCE_COMMIT" ]; then
  SOURCE_COMMIT="$(GIT_OPTIONAL_LOCKS=0 git -C "$(dirname "$0")" rev-parse --verify HEAD 2>/dev/null || true)"
  SOURCE_COMMIT_FROM="the checkout at $(dirname "$0")"
else
  SOURCE_COMMIT_FROM="--source-commit"
fi
if [[ "$SOURCE_COMMIT" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  SRC_SHA="$SOURCE_COMMIT"
elif [ "$ALLOW_UNPINNED_SOURCE" -eq 1 ]; then
  SRC_SHA="unpinned"
else
  echo "setup error: no source commit for the provenance (from $SOURCE_COMMIT_FROM: '${SOURCE_COMMIT}'). Pass --source-commit <40-hex sha> (the bake passes its pinned build-context commit), or --allow-unpinned-source for an unpinned test bake the release gate will refuse." >&2
  exit 2
fi
echo "SOURCE_COMMIT=$SRC_SHA"

COSIGN_IMG="${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
SKOPEO_IMG="${SKOPEO_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
SYFT="${SYFT_BIN:-$(command -v syft || true)}"
GRYPE="${GRYPE_BIN:-$(command -v grype || true)}"

PODMAN=(podman)
[ "$(id -u)" -ne 0 ] && PODMAN=(sudo -n podman)

mkdir -p "$OUTDIR" || { echo "setup error: cannot create $OUTDIR" >&2; exit 2; }
OUTDIR="$(cd "$OUTDIR" && pwd)"
KEYDIR="$(cd "$(dirname "$KEY")" && pwd)"
KEYFILE="$(basename "$KEY")"
PUBFILE="$(basename "$PUBKEY")"

TLS_ARGS=(); COSIGN_INSECURE=()
if [ "$INSECURE" -eq 1 ]; then
  TLS_ARGS=(--tls-verify=false)
  COSIGN_INSECURE=(--allow-insecure-registry)
fi

step() { printf '\n=== %s ===\n' "$1"; }
die()  { echo "FAILED: $1" >&2; echo "SUPPLY_CHAIN_RESULT=FAIL"; exit "${2:-1}"; }

# The cosign image's default user is `nonroot` (uid 65532). A release key is rightly 0600 in a
# 0700 directory owned by whoever runs this script, so that default user cannot open it and
# signing dies with "reading key: open /keys/cosign.key: permission denied" after the whole
# image build has already been paid for (measured 2026-10-02, WI-10005606). Run cosign as the
# CALLER's uid:gid instead: it owns the key and $OUTDIR, so nothing needs loosening, and the
# files cosign writes under /out stay owned by the caller rather than by root or 65532.
# HOME points at /tmp because the caller's uid has no passwd entry in the distroless image.
COSIGN_USER="$(id -u):$(id -g)"
cosign_run() {
  "${PODMAN[@]}" run --rm --network host --user "$COSIGN_USER" -e HOME=/tmp \
    -v "$KEYDIR":/keys -v "$OUTDIR":/out -w /out \
    -e COSIGN_PASSWORD="${COSIGN_PASSWORD-}" "$COSIGN_IMG" "$@"
}

# ---------------------------------------------------------------------------------------------
step "1/6  resolve the DIGEST from the registry (D-288 / D-287)"
# A tag is a NAME. Everything downstream must be pinned to the object, so the tag is resolved
# exactly once, here, against the registry — not against the local store, which is a claim about
# the local store and was measured pointing at another repository's manifest entry.
# ⚠ A PORT'S COLON IS NOT A TAG'S COLON. The obvious `REPO="${REPO%:*}"` strips the shortest
# `:*` suffix, so on a ported registry it eats the port AND the whole path:
#   127.0.0.1:5096/papercusp/workspace-host  ->  127.0.0.1
# cosign then resolved that as a Docker Hub repo (`index.docker.io/v2/library/127.0.0.1`) and
# failed with UNAUTHORIZED — an auth error that names a registry nobody asked for, so it reads
# as a credentials problem rather than a parsing one. Measured 2026-09-04 by P-307's end-to-end
# bake, the first run to point this script at a registry with a port.
# A tag's colon is always in the LAST path segment; a port's colon is always before a `/`.
REPO="${IMAGE%@*}"
case "${REPO##*/}" in *:*) REPO="${REPO%:*}";; esac
DIGEST=""
case "$IMAGE" in
  *@sha256:*) DIGEST="${IMAGE#*@}"; echo "input was already digest-pinned";;
  *)          echo "input is a TAG — resolving to a digest before anything is signed";;
esac

if [ -z "$DIGEST" ]; then
  DIGEST="$("${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$SKOPEO_IMG" \
    inspect "${TLS_ARGS[@]}" --format '{{.Digest}}' "docker://$IMAGE" 2>"$OUTDIR/skopeo.err")"
fi
case "$DIGEST" in
  sha256:*) ;;
  *) echo "could not resolve a registry digest for $IMAGE"; sed -n '1,5p' "$OUTDIR/skopeo.err" 2>/dev/null
     die "digest resolution" 2;;
esac
REF="$REPO@$DIGEST"
echo "REPO=$REPO"
echo "DIGEST=$DIGEST"
echo "REF=$REF   <- every cosign call below uses THIS, never the tag"

# ---------------------------------------------------------------------------------------------
# 1b. Secret scan BEFORE anything is signed (WI-10005624). A signature and a provenance
# attestation are the publisher's statement that the image is fit to ship, so an image that
# carries a credential is refused before that statement exists rather than reported beside it.
# The scan is bound to $REF (the digest) and writes secret-scan.{json,log} into $OUTDIR, which
# is where bootc-image-release-request-cli reads them; that reader fails closed on a missing
# record, so --skip-secret-scan yields an image the release gate will refuse.
SECRET_SCAN_BIN="${SECRET_SCAN_BIN:-$(dirname "$0")/image-secret-scan.sh}"
if [ "$SKIP_SECRET_SCAN" -eq 1 ]; then
  step "1b/6 secret scan SKIPPED (--skip-secret-scan) — the release gate will refuse this image"
  SECRET_SCAN="skipped"
else
  step "1b/6 secret scan of the image root filesystem, bound to the DIGEST, before signing"
  [ -x "$SECRET_SCAN_BIN" ] || die "secret scanner not executable: $SECRET_SCAN_BIN (set SECRET_SCAN_BIN)" 2
  SS_ARGS=(--image "$REF" --out "$OUTDIR")
  [ "$INSECURE" -eq 1 ] && SS_ARGS+=(--insecure-registry)
  "$SECRET_SCAN_BIN" "${SS_ARGS[@]}"
  SS_RC=$?
  case "$SS_RC" in
    0) SECRET_SCAN="clean" ;;
    1) echo "SUPPLY_CHAIN_RESULT=SECRET_FINDINGS"
       echo "  the image carries secret-scan findings (see $OUTDIR/secret-scan.log); nothing was signed."
       exit 4 ;;
    *) die "secret scan did not complete (exit $SS_RC); without a verdict nothing is signed" ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
step "2/6  cosign sign (key-based, no transparency log — D-249)"
cosign_run sign --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" "$REF" \
  > "$OUTDIR/sign.log" 2>&1 || { tail -5 "$OUTDIR/sign.log"; die "cosign sign"; }
echo "signed $REF"

# ---------------------------------------------------------------------------------------------
step "3/6  SLSA v1 provenance predicate"
# Recorded from the build environment. `sourceCheckout` is the checkout state at build time — it
# is provenance about the BUILD, not an authorship claim; on this shared, sweep-committed tree a
# commit's author and subject say nothing reliable about a change (see the repo guide).
# SRC_SHA was resolved and validated before signing (see the setup block above).
[ -n "$BASE_IMG" ] || BASE_IMG="$(sed -n 's/^ARG PAPERCUSP_BASE_IMAGE=//p' "$(dirname "$0")/workspace-host.Containerfile" 2>/dev/null | head -1)"
[ -n "$BASE_IMG" ] || BASE_IMG="unknown"
python3 - "$BUILD_TYPE" "$CONTAINERFILE" "$REPO" "$BASE_IMG" "$SRC_SHA" "$BUILDER_ID" "$DIGEST" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUTDIR/provenance.json" <<'PRED' \
  || die "could not encode artifact provenance"
import json, sys
build_type, containerfile, image, base, source, builder, digest, started = sys.argv[1:]
json.dump({
    "buildDefinition": {
        "buildType": build_type,
        "externalParameters": {"containerfile": containerfile, "image": image, "baseImage": base},
        "internalParameters": {"sourceCheckout": source},
        "resolvedDependencies": [{"uri": base}],
    },
    "runDetails": {
        "builder": {"id": builder},
        "metadata": {"invocationId": digest, "startedOn": started},
    },
}, sys.stdout, indent=2)
sys.stdout.write("\n")
PRED
chmod a+r "$OUTDIR/provenance.json" 2>/dev/null || true
echo "base image: $BASE_IMG"

step "4/6  cosign attest --type slsaprovenance1, bound to the DIGEST"
cosign_run attest --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" \
  --type slsaprovenance1 --predicate provenance.json "$REF" \
  > "$OUTDIR/attest-provenance.log" 2>&1 \
  || { tail -5 "$OUTDIR/attest-provenance.log"; die "cosign attest (provenance)"; }
echo "attested provenance to $REF"

# ---------------------------------------------------------------------------------------------
if [ "$SKIP_SCAN" -eq 1 ]; then
  step "5/6  SBOM + scan SKIPPED (--skip-scan)"
  SBOM_PKGS="skipped"; ACTIONABLE="skipped"; VENDOR_PENDING="skipped"; VENDOR_CHECK="skipped"; STALE_OBJECTS="skipped"
else
  [ -n "$SYFT" ] && [ -x "$SYFT" ]   || die "syft not found (set SYFT_BIN)" 2
  [ -n "$GRYPE" ] && [ -x "$GRYPE" ] || die "grype not found (set GRYPE_BIN)" 2

  step "5/6  SBOM (syft) + vulnerability scan (grype), then attest the SBOM to the same digest"
  # grype must be proven to HAVE a database first: a missing DB yields zero matches, which is
  # indistinguishable from a clean image and is the one result this step must never fabricate.
  "$GRYPE" db status > "$OUTDIR/grype-db.txt" 2>&1
  grep -qi 'Status:.*valid' "$OUTDIR/grype-db.txt" \
    || { cat "$OUTDIR/grype-db.txt"; die "grype has no valid DB — a scan now would report a FALSE CLEAN" 2; }

  # Scan the registry object by DIGEST, so the SBOM describes the artifact being signed rather
  # than whatever the local store happens to hold under that name.
  SYFT_SRC="registry:$REF"
  [ "$INSECURE" -eq 1 ] && export SYFT_REGISTRY_INSECURE_USE_HTTP=true
  "$SYFT" "$SYFT_SRC" -o "spdx-json=$OUTDIR/sbom.spdx.json" -o "syft-json=$OUTDIR/sbom.syft.json" \
    > "$OUTDIR/syft.log" 2>&1 || { tail -5 "$OUTDIR/syft.log"; die "syft"; }
  [ -s "$OUTDIR/sbom.syft.json" ] || die "syft produced an EMPTY SBOM — nothing was measured"

  SBOM_PKGS=$(jq '.artifacts | length' "$OUTDIR/sbom.syft.json")
  echo "SBOM_PACKAGES=$SBOM_PKGS"
  [ "$SBOM_PKGS" -ge "$MIN_PKGS" ] || die "only $SBOM_PKGS packages (floor $MIN_PKGS) — syft did not read the image; this measured NOTHING"

  "$GRYPE" "sbom:$OUTDIR/sbom.syft.json" -o json > "$OUTDIR/vulns.json" 2> "$OUTDIR/grype.log" \
    || { tail -5 "$OUTDIR/grype.log"; die "grype"; }

  TOTAL=$(jq '.matches | length' "$OUTDIR/vulns.json")
  # EL (el9, el10, ...) kernels are vendor-maintained RPMs. An `nvd:cpe` match against one of those RPMs
  # compares its vendor version with an upstream kernel fixed version and therefore cannot
  # establish that the vendor package is vulnerable: the fix may already be backported. Keep
  # vendor-namespace matches actionable, but exclude only this unsupported generic-CPE shape.
  # The package/type/elN guard prevents an unrelated artifact whose name happens to contain
  # "kernel" from silently leaving the gate population.
  # The vendor kernel reaches grype as TWO artifact types: `rpm` (kernel, kernel-core, ...) and
  # `linux-kernel` — syft's binary cataloger reading usr/lib/modules/<release>/vmlinuz
  # (pkg:generic/linux-kernel@5.14.0-730.el9.x86_64). The latter is the same vendor kernel, carries
  # the same .el9 release and is matched ONLY by upstream NVD CPE; the RPMs stay matched in the
  # vendor namespace. Measured on the P-012 AWS bake: 2,226 of 2,328 "actionable" were the
  # linux-kernel artifact while this filter accepted rpm only (WI-10005674). Mirrored exactly by
  # isGenericElKernelCpe in apps/operator/lib/release/bootc-image-release-request-cli.ts.
  # The release tag is matched as el<major>, not el9: the base moved to EL10 (D-035, WI-10005910).
  #
  # D-027 (WI-10005719) — VENDOR-PENDING. A fixed Critical/High finding stays ACTIONABLE unless
  # BOTH hold: (a) the vendor owns it — every file it sits in is listed by an INSTALLED RPM in the
  # attested SBOM itself (the rpmdb-located rpm artifacts' metadata.files), or the artifact IS an
  # installed RPM (located in the rpmdb) — and (b) the built image's own repos hold nothing newer:
  # `dnf --refresh check-update` exit 0 inside the image, with at least one enabled repo and
  # MIN_AVAILABLE_PACKAGES available as the positive control that dnf really read its metadata.
  # Such a finding is a fix the vendor has not shipped, which no rebuild here can reach. It leaves
  # the deny population but is counted (GRYPE_VENDOR_PENDING) and listed (vendor-pending.json),
  # never dropped silently. check-update exit 100 (an update EXISTS) or any error keeps every
  # candidate actionable, so a fix the vendor HAS shipped can never be classified pending. Files
  # papercusp installs outside RPM (/opt/papercusp, bundled runtimes) and stale base-layer copies
  # (/sysroot/ostree/repo/objects) are owned by no installed RPM and stay actionable. An `.rpm`
  # ARCHIVE lying in the image is not installed (its location is not the rpmdb), so it neither
  # owns files nor counts as vendor-owned. Mirrored exactly by vendorOwnership +
  # actionableGrypeReport in apps/operator/lib/release/bootc-image-release-request-cli.ts.
  JQ_GATE_DEFS='
    def generic_kernel_cpe:
      ((.artifact.name // "") | ascii_downcase | test("(^|-)kernel($|-)"))
      and (((.artifact.type // "") | ascii_downcase) as $t | $t == "rpm" or $t == "linux-kernel")
      and ((.artifact.version // "") | ascii_downcase | test("(^|[.-])el[0-9]+([._-]|$)"))
      and ((.vulnerability.namespace // "") | ascii_downcase) == "nvd:cpe";
    def fixed_crit_high:
      .vulnerability.fix.state == "fixed"
      and (.vulnerability.severity == "Critical" or .vulnerability.severity == "High");
    def rpmdb_path: test("/rpm/(rpmdb\\.sqlite|Packages(\\.db)?)$");
    def installed_rpm($paths):
      ((.type // "") | ascii_downcase) == "rpm"
      and ($paths | length > 0 and all(.[]; rpmdb_path));
    def finding_paths: [(.artifact.locations // [])[] | (.path // "")];
    def ostree_object: test("^/sysroot/ostree/repo/objects/[0-9a-f]{2}/[0-9a-f]{62}\\.file$");
    def effective_paths($idx):
      [finding_paths[] as $p
        | ((($idx[$p] // {}).livePaths) // []) as $live
        | if ($live | length) > 0 then $live[] else $p end];
    def stale_object($idx):
      finding_paths | length > 0
        and all(.[]; ostree_object and (($idx[.] // {}) | .stale == true and (((.livePaths // []) | length) == 0)));
    def vendor_owned($owned; $idx):
      (.artifact | installed_rpm([(.locations // [])[] | (.path // "")]))
      or (effective_paths($idx) | length > 0 and all(.[]; $owned[.] == true));
  '
  GENERIC_KERNEL_CPE_EXCLUDED=$(jq "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe)] | length
  ' "$OUTDIR/vulns.json")
  ACTIONABLE=$(jq "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe | not)] | length
  ' "$OUTDIR/vulns.json")

  # (a) every path an installed RPM owns, from the same SBOM grype just scanned.
  jq "$JQ_GATE_DEFS"'
    [.artifacts[]?
      | select(installed_rpm([(.locations // [])[] | (.path // "")]))
      | (.metadata.files // [])[] | (.path // empty)]
    | unique | map({key: ., value: true}) | from_entries
  ' "$OUTDIR/sbom.syft.json" > "$OUTDIR/rpm-owned-paths.json" \
    || die "could not derive RPM file ownership from the SBOM"
  # D-029: syft locates a base-layer binary the build did not replace at its ostree OBJECT
  # (/sysroot/ostree/repo/objects/xx/<sha>.file — the base layer hardlinks the live path to it),
  # so the probe below resolves each object-located finding to the live path(s) with identical
  # content, or proves it has none (a stale base copy the deployed tree never references).
  OBJECT_PATHS=$(jq -r "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe | not)
      | finding_paths[] | select(ostree_object)] | unique | .[]
  ' "$OUTDIR/vulns.json") || die "could not list ostree-object findings"
  OWNED_BEFORE=$(jq --slurpfile owned "$OUTDIR/rpm-owned-paths.json" "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe | not)
      | select(vendor_owned($owned[0]; {}))] | length
  ' "$OUTDIR/vulns.json") || die "could not classify vendor-owned findings"

  # (b) does the vendor already ship something newer? Asked only when a candidate exists, inside
  # the image at this DIGEST, against the repos the image itself is configured with.
  VENDOR_CHECK="not-needed"; VENDOR_PENDING=0; VENDOR_NOTHING_NEWER=0
  echo '{}' > "$OUTDIR/ostree-object-index.json"
  rm -f "$OUTDIR/ostree-objects.json" "$OUTDIR/vendor-check.attempt1.log"
  if [ "$OWNED_BEFORE" -gt 0 ] || [ -n "$OBJECT_PATHS" ]; then
    VENDOR_CHECK_SH=$(cat <<'SH'
dnf -q --refresh check-update; rc=$?
echo "VENDOR_CHECK_UPDATE_EXIT=$rc"
echo "VENDOR_ENABLED_REPOS=$(dnf -q -C repolist --enabled 2>/dev/null | awk 'NR > 1 && NF' | wc -l)"
echo "VENDOR_AVAILABLE_PACKAGES=$(dnf -q -C repoquery --available --qf '%{name}\n' 2>/dev/null | sort -u | wc -l)"
printf '%s\n' "${PAPERCUSP_OSTREE_OBJECTS:-}" > /tmp/objects
while IFS= read -r obj; do
  [ -n "$obj" ] || continue
  if [ ! -f "$obj" ]; then echo "OSTREE_OBJECT_MISSING $obj"; continue; fi
  sum=$(sha256sum "$obj" | cut -d' ' -f1); live=0
  find / -xdev \( -path /sysroot -o -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp \) \
    -prune -o -type f -size "$(stat -c %s "$obj")c" -print 2>/dev/null > /tmp/same-size
  while IFS= read -r f; do
    if [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$sum" ]; then echo "OSTREE_OBJECT_LIVE $obj $f"; live=1; fi
  done < /tmp/same-size
  [ "$live" -eq 1 ] || echo "OSTREE_OBJECT_STALE $obj $sum"
done < /tmp/objects
echo "OSTREE_OBJECT_DONE"
SH
)
    # One retry when the probe is incomplete (WI-10006045). Measured 2026-10-03 on the P-012 B
    # bake: one write to /tmp inside the probe container failed with "Transport endpoint is not
    # connected", the probe resolved 111 of 117 objects but counted as incomplete, so it relocated
    # nothing and 187 RPM-owned findings stayed actionable. /tmp is a tmpfs so the probe's scratch
    # files never touch the image rootfs; a still-incomplete second attempt keeps the fail-closed
    # verdict below, and the first attempt's log is kept beside the second.
    for PROBE_ATTEMPT in 1 2; do
    VC_RC=0
    "${PODMAN[@]}" run --rm --network host "${TLS_ARGS[@]}" --tmpfs /tmp -e PAPERCUSP_OSTREE_OBJECTS="$OBJECT_PATHS" \
      --entrypoint /bin/sh "$REF" -c "$VENDOR_CHECK_SH" > "$OUTDIR/vendor-check.log" 2>&1 || VC_RC=$?
    vc_field() { sed -n "s/^$1=\([0-9][0-9]*\)\$/\1/p" "$OUTDIR/vendor-check.log" | tail -1; }
    CU_EXIT=$(vc_field VENDOR_CHECK_UPDATE_EXIT)
    VC_REPOS=$(vc_field VENDOR_ENABLED_REPOS)
    VC_AVAIL=$(vc_field VENDOR_AVAILABLE_PACKAGES)
    if [ "$VC_RC" -eq 0 ] && [ "$CU_EXIT" = "0" ] && [ "${VC_REPOS:-0}" -ge 1 ] \
       && [ "${VC_AVAIL:-0}" -ge "$MIN_AVAILABLE_PACKAGES" ]; then
      VENDOR_CHECK="no-updates"; VENDOR_NOTHING_NEWER=1
    elif [ "$CU_EXIT" = "100" ]; then
      VENDOR_CHECK="updates-available"
    else
      VENDOR_CHECK="error"
    fi
    jq -n --arg digest "$DIGEST" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg verdict "$VENDOR_CHECK" --argjson containerExit "$VC_RC" \
      --arg cu "${CU_EXIT:-}" --arg repos "${VC_REPOS:-}" --arg avail "${VC_AVAIL:-}" \
      --argjson floor "$MIN_AVAILABLE_PACKAGES" \
      '{ digest: $digest, checkedAt: $checkedAt, verdict: $verdict, containerExit: $containerExit,
         checkUpdateExit: ($cu | tonumber? // null), enabledRepos: ($repos | tonumber? // null),
         availablePackages: ($avail | tonumber? // null), availablePackagesFloor: $floor }' \
      > "$OUTDIR/vendor-updates.json" || die "could not record vendor-updates.json"
    # Complete only when the container exited 0, reached its end marker, and gave EVERY object a
    # verdict; an incomplete probe relocates nothing and proves nothing stale.
    jq -Rn --arg digest "$DIGEST" --arg wanted "$OBJECT_PATHS" --argjson rc "$VC_RC" '
      [inputs | capture("^(?<kind>OSTREE_OBJECT_[A-Z]+)(?: (?<path>[^ ]+)(?: (?<other>.*))?)?$")] as $lines
      | [$wanted | split("\n")[] | select(length > 0)
         | . as $p
         | { path: $p,
             livePaths: [$lines[] | select(.kind == "OSTREE_OBJECT_LIVE" and .path == $p) | .other],
             stale: any($lines[]; .kind == "OSTREE_OBJECT_STALE" and .path == $p),
             sha256: (first($lines[] | select(.kind == "OSTREE_OBJECT_STALE" and .path == $p) | .other) // null) }
        ] as $objects
      | { digest: $digest, objects: $objects,
          complete: ($rc == 0 and any($lines[]; .kind == "OSTREE_OBJECT_DONE")
                     and all($objects[]; (.livePaths | length) > 0 or .stale)) }
    ' "$OUTDIR/vendor-check.log" > "$OUTDIR/ostree-objects.json" || die "could not record ostree-objects.json"
    if [ -z "$OBJECT_PATHS" ] || [ "$(jq -r '.complete' "$OUTDIR/ostree-objects.json")" = "true" ]; then break; fi
    if [ "$PROBE_ATTEMPT" -eq 1 ]; then
      cp -f "$OUTDIR/vendor-check.log" "$OUTDIR/vendor-check.attempt1.log"
      echo "OSTREE_PROBE_RETRY attempt 1 incomplete (container exit $VC_RC; log kept as vendor-check.attempt1.log)"
    fi
    done
    jq 'if .complete then (.objects | map({key: .path, value: .}) | from_entries) else {} end' \
      "$OUTDIR/ostree-objects.json" > "$OUTDIR/ostree-object-index.json" || die "could not index ostree objects"
  fi
  # Classify with the probe's index: a stale base object first (D-029), then vendor ownership over
  # the relocated paths (D-027/D-028). Both lists are written whatever the verdict, so the counts
  # below are always backed by a file a reviewer can read.
  JQ_LIST='{ id: .vulnerability.id, severity: .vulnerability.severity,
             namespace: .vulnerability.namespace, fixedIn: (.vulnerability.fix.versions // []),
             artifact: { name: .artifact.name, version: .artifact.version, type: .artifact.type },
             paths: finding_paths, livePaths: effective_paths($idx[0]) }'
  jq --slurpfile idx "$OUTDIR/ostree-object-index.json" "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe | not)
      | select(stale_object($idx[0])) | '"$JQ_LIST"']
  ' "$OUTDIR/vulns.json" > "$OUTDIR/stale-base-objects.json" || die "could not classify stale base objects"
  jq --slurpfile owned "$OUTDIR/rpm-owned-paths.json" --slurpfile idx "$OUTDIR/ostree-object-index.json" "$JQ_GATE_DEFS"'
    [.matches[] | select(fixed_crit_high) | select(generic_kernel_cpe | not)
      | select(stale_object($idx[0]) | not) | select(vendor_owned($owned[0]; $idx[0])) | '"$JQ_LIST"']
  ' "$OUTDIR/vulns.json" > "$OUTDIR/vendor-pending-candidates.json" || die "could not classify vendor-owned findings"
  STALE_OBJECTS=$(jq 'length' "$OUTDIR/stale-base-objects.json")
  VENDOR_CANDIDATES=$(jq 'length' "$OUTDIR/vendor-pending-candidates.json")
  if [ "$VENDOR_NOTHING_NEWER" -eq 1 ]; then
    VENDOR_PENDING=$VENDOR_CANDIDATES
    cp "$OUTDIR/vendor-pending-candidates.json" "$OUTDIR/vendor-pending.json"
  else
    echo '[]' > "$OUTDIR/vendor-pending.json"
  fi
  ACTIONABLE=$((ACTIONABLE - VENDOR_PENDING - STALE_OBJECTS))
  # ⛔ D-289: the raw total is not a verdict. Measured on the P-306 image, 4 kernel RPMs each
  # reported an IDENTICAL 5,395 matches — one kernel's CVE set counted four times under four
  # names — so ~95% of a 29,872 headline was a single component counted repeatedly. Print the
  # dominating component beside the total so the number is never quoted bare.
  echo "GRYPE_MATCHES_RAW=$TOTAL   (matches, NOT distinct vulnerabilities — do not quote bare)"
  echo "GRYPE_TOP_COMPONENT=$(jq -r '.matches | group_by(.artifact.name) | max_by(length) | "\(.[0].artifact.name)=\(length)"' "$OUTDIR/vulns.json")"
  echo "GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=$GENERIC_KERNEL_CPE_EXCLUDED   (EL upstream CPE matches; vendor namespaces remain actionable)"
  echo "GRYPE_VENDOR_PENDING=$VENDOR_PENDING   (of $VENDOR_CANDIDATES RPM-owned; vendor check: $VENDOR_CHECK; listed in vendor-pending.json — D-027)"
  echo "GRYPE_STALE_BASE_OBJECTS=$STALE_OBJECTS   (base-layer ostree objects with no live copy in the image; listed in stale-base-objects.json — D-029)"
  # Say whether the ostree probe completed: an incomplete probe relocates nothing, so every
  # finding inside an ostree object stays actionable. The bake log must not present those as
  # vulnerabilities without saying why they were not classified (WI-10006045).
  if [ -f "$OUTDIR/ostree-objects.json" ]; then
    echo "GRYPE_OSTREE_PROBE=$(jq -r '"\(if .complete then "complete" else "INCOMPLETE" end) (\([.objects[] | select((.livePaths | length) > 0 or .stale)] | length) of \(.objects | length) objects resolved)"' "$OUTDIR/ostree-objects.json")$( [ "$(jq -r '.complete' "$OUTDIR/ostree-objects.json")" = "true" ] || echo '   <- nothing was relocated, so findings in ostree objects stay actionable; see vendor-check.log')"
  else
    echo "GRYPE_OSTREE_PROBE=not-run (no ostree objects among the findings)"
  fi
  case "$VENDOR_CHECK" in
    updates-available) echo "  the image's repos ship NEWER RPMs (vendor-check.log): re-bake so the Containerfile's dnf upgrade takes them; nothing is pending" ;;
    error) echo "  the vendor check did not complete (vendor-check.log): every RPM-owned finding stays actionable" ;;
  esac
  echo "GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=$ACTIONABLE   <- the gate population"

  # The SBOM travels WITH the image, attested to the same digest, so a consumer can obtain it
  # without trusting a build-log artifact store.
  cp "$OUTDIR/sbom.spdx.json" "$OUTDIR/sbom-attest.json"
  chmod a+r "$OUTDIR/sbom-attest.json" 2>/dev/null || true
  cosign_run attest --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" \
    --type spdxjson --predicate sbom-attest.json "$REF" \
    > "$OUTDIR/attest-sbom.log" 2>&1 \
    || { tail -5 "$OUTDIR/attest-sbom.log"; die "cosign attest (sbom)"; }
  echo "attested SBOM to $REF"
fi

# ---------------------------------------------------------------------------------------------
step "6/6  VERIFY BACK from the registry — a cosign exit 0 is not a verifiable artifact"
V=0
cosign_run verify --key "/keys/$PUBFILE" --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" \
  > "$OUTDIR/verify-sig.log" 2>&1 \
  && echo "VERIFY_SIGNATURE=ok" || { echo "VERIFY_SIGNATURE=FAILED"; tail -3 "$OUTDIR/verify-sig.log"; V=1; }

cosign_run verify-attestation --key "/keys/$PUBFILE" --type slsaprovenance1 \
  --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" > "$OUTDIR/verify-prov.json" 2>"$OUTDIR/verify-prov.err" \
  && echo "VERIFY_PROVENANCE=ok" || { echo "VERIFY_PROVENANCE=FAILED"; tail -3 "$OUTDIR/verify-prov.err"; V=1; }

# The binding itself: the in-toto subject digest must BE this image's digest. This is the check
# that a tag-bound attestation silently fails (D-288), so it is asserted rather than assumed.
if [ -s "$OUTDIR/verify-prov.json" ]; then
  SUBJ=$(jq -r 'select(.payload) | .payload' "$OUTDIR/verify-prov.json" 2>/dev/null | head -1 \
         | base64 -d 2>/dev/null | jq -r '.subject[0].digest.sha256 // "MISSING"' 2>/dev/null)
  if [ "sha256:$SUBJ" = "$DIGEST" ]; then
    echo "VERIFY_SUBJECT_BINDING=ok  (in-toto subject == $DIGEST)"
  else
    echo "VERIFY_SUBJECT_BINDING=FAILED  (subject=$SUBJ expected=$DIGEST)"; V=1
  fi
fi

if [ "$SKIP_SCAN" -eq 0 ]; then
  cosign_run verify-attestation --key "/keys/$PUBFILE" --type spdxjson \
    --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" > "$OUTDIR/verify-sbom.json" 2>"$OUTDIR/verify-sbom.err" \
    && echo "VERIFY_SBOM_ATTESTATION=ok" || { echo "VERIFY_SBOM_ATTESTATION=FAILED"; tail -3 "$OUTDIR/verify-sbom.err"; V=1; }
fi

[ "$V" -eq 0 ] || die "verify-back — the artifact was published but a puller could NOT verify it"

cat > "$OUTDIR/supply-chain-summary.json" <<SUM
{
  "repository": "$REPO",
  "digest": "$DIGEST",
  "reference": "$REF",
  "signed": true,
  "provenanceAttested": true,
  "sbomAttested": $( [ "$SKIP_SCAN" -eq 0 ] && echo true || echo false ),
  "sbomPackages": "$SBOM_PKGS",
  "actionableCriticalHighWithFix": "$ACTIONABLE",
  "vendorPending": "$VENDOR_PENDING",
  "vendorCheck": "$VENDOR_CHECK",
  "staleBaseObjects": "$STALE_OBJECTS",
  "secretScan": "$SECRET_SCAN",
  "verifiedFromRegistry": true
}
SUM
echo; echo "artifacts in $OUTDIR (summary: supply-chain-summary.json)"

if [ "$SKIP_SCAN" -eq 0 ] && [ "$FAIL_ON_VULNS" -eq 1 ] && [ "$ACTIONABLE" -gt 0 ]; then
  echo "SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED"
  echo "  $ACTIONABLE Critical/High findings HAVE A FIX AVAILABLE. Rebase the base image."
  exit 3
fi

echo "SUPPLY_CHAIN_RESULT=PASS"
exit 0
