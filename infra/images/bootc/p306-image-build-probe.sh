#!/usr/bin/env bash
#
# P-306 — the falsifier for the product workspace-host bootc image.
#
#   sudo -n bash infra/images/bootc/p306-image-build-probe.sh
#
# Builds `workspace-host.Containerfile` and asserts the properties the port
# claims. Committed so the claim is re-runnable rather than a one-off transcript
# line, in the same spirit as `p306-signature-policy-probe.sh` (D-279) and
# `verify-rpm-equivalents.sh` (P-304).
#
# ── What it establishes, and what it deliberately does NOT ────────────────────
#
# ESTABLISHES (container-level, zero cloud spend):
#   * the image BUILDS from the verified RPM package set;
#   * `bootc container lint` adds ZERO regressions against the bare base — the
#     base's own warning count is measured in the same run as a CONTROL, so
#     "clean" is a comparison rather than an absolute nobody can check;
#   * the three identities and immutable runtime-read group exist with PINNED
#     uid/gid, the exact service+agent allowlist is present, and refused
#     memberships are absent;
#   * the signature policy, firewall ruleset, sysusers file and both units are
#     present and enabled;
#   * the firewall ruleset PARSES, with a negative control proving the check can
#     fail (a syntax check that cannot reject anything proves nothing).
#   * a named release-context hardlink group commits as distinct normalized
#     root:papercusp-runtime-read inodes, including paths containing spaces.
#
# DOES NOT ESTABLISH — do not read a pass here as any of these:
#   * that `/opt` survives as image content on a BOOTED host. That is the open
#     question in layer 7 of the Containerfile, it decides whether the baked
#     runtime design holds at all, and no container-level probe can answer it —
#     a container always shows the image's own view. `papercusp-host-prepare.sh`
#     asserts it at boot; P-305 owes the booted run.
#   * that the machine-local workspace ACL applies correctly on the booted image
#     filesystem. Immutable `/opt` access is ordinary committed group metadata.
#   * that a mis-signed image is refused by a booted `bootc upgrade`. D-279
#     proved the enforcement path; the booted hop remains an inference.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="quay.io/centos-bootc/centos-bootc:stream9"
TAG="papercusp/workspace-host:p306-probe"
FAILURES=0
PODMAN=(podman)
PRIVATE_STORAGE_ROOT=""
PRIVATE_RUN_ROOT=""

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
sect() { echo; echo "== $* =="; }
die() { echo "P306_IMAGE_BUILD_PROBE ERROR $*" >&2; exit 2; }

# Rootful Podman can report the overlay driver while silently routing every
# upperdir operation through fuse-overlayfs.  Once that store contains a
# `.has-mount-program` marker, a build can wedge during teardown in
# cgroup_writeback_umount even after the overlay has detached.  Never mutate or
# migrate the shared store here: detect the unsafe shape, then run the whole
# probe in fresh storage whose graph root is explicitly isolated.  A temporary
# root also makes the probe's image/build/run lifecycle self-contained.
cleanup_private_storage() {
  [ -z "$PRIVATE_STORAGE_ROOT" ] || rm -rf -- "$PRIVATE_STORAGE_ROOT"
  [ -z "$PRIVATE_RUN_ROOT" ] || rm -rf -- "$PRIVATE_RUN_ROOT"
}
trap cleanup_private_storage EXIT

storage_driver="$("${PODMAN[@]}" info --format '{{.Store.GraphDriverName}}' 2>/dev/null | tr -d '[:space:]')"
graph_root="$("${PODMAN[@]}" info --format '{{.Store.GraphRoot}}' 2>/dev/null | tr -d '\r\n')"
run_root="$("${PODMAN[@]}" info --format '{{.Store.RunRoot}}' 2>/dev/null | tr -d '\r\n')"
native_overlay_diff="$("${PODMAN[@]}" info --format '{{index .Store.GraphStatus "Native Overlay Diff"}}' 2>/dev/null | tr -d '[:space:]')"
[ -n "$storage_driver" ] || die "could not determine rootful Podman graph driver"
[ -n "$graph_root" ] || die "could not determine rootful Podman graph root"
[ -n "$run_root" ] || die "could not determine rootful Podman run root"

mount_program_marker=0
if [ "$storage_driver" = overlay ] && [ -f "${graph_root%/}/overlay/.has-mount-program" ]; then
  mount_program_marker=1
fi
needs_private_storage=0
if [ "$storage_driver" = overlay ]; then
  case "$native_overlay_diff" in
    true|True|TRUE) ;;
    *) needs_private_storage=1 ;;
  esac
  [ "$mount_program_marker" -eq 1 ] && needs_private_storage=1
fi
echo "P306_STORAGE_PRECHECK driver=$storage_driver graph_root=$graph_root native_overlay_diff=${native_overlay_diff:-unknown} mount_program_marker=$mount_program_marker"

if [ "$needs_private_storage" -eq 1 ]; then
  storage_parent="${P306_PRIVATE_STORAGE_PARENT:-$(dirname "$graph_root")}"
  run_parent="${P306_PRIVATE_RUN_PARENT:-$(dirname "$run_root")}"
  case "$storage_parent:$run_parent" in
    /*:/*) ;;
    *) die "private Podman storage parents must be absolute paths" ;;
  esac
  mkdir -p "$storage_parent" "$run_parent" || die "cannot create private Podman storage parents"
  PRIVATE_STORAGE_ROOT="$(mktemp -d "$storage_parent/p306-probe-storage.XXXXXX")" \
    || die "cannot create private Podman graph root under $storage_parent"
  PRIVATE_RUN_ROOT="$(mktemp -d "$run_parent/p306-probe-run.XXXXXX")" \
    || die "cannot create private Podman run root under $run_parent"
  PODMAN=(podman --root "$PRIVATE_STORAGE_ROOT" --runroot "$PRIVATE_RUN_ROOT")
  echo "P306_STORAGE_MODE=private reason=non-native-overlay-or-mount-program-marker graph_root=$PRIVATE_STORAGE_ROOT run_root=$PRIVATE_RUN_ROOT"
else
  echo "P306_STORAGE_MODE=shared reason=storage-driver-safe"
fi

in_image() { "${PODMAN[@]}" run --rm --entrypoint /bin/bash "$TAG" -c "$1" 2>/dev/null; }
BUILD_LOG="${P306_BUILD_LOG:-${TMPDIR:-/tmp}/p306-build.log}"

echo "P306_IMAGE_BUILD_PROBE start $(date -u +%FT%TZ)"

sect "1. build"
if "${PODMAN[@]}" build -f "$HERE/workspace-host.Containerfile" -t "$TAG" "$HERE" >"$BUILD_LOG" 2>&1; then
  build_steps="$(grep -Ec '^(\[[0-9]+/[0-9]+\][[:space:]]+)?STEP[[:space:]]' "$BUILD_LOG" || true)"
  if (( build_steps > 0 )); then
    pass "image builds ($build_steps steps)"
  else
    fail "image build emitted no recognizable STEP lines — build-progress instrument is blind"
  fi
  if grep -Eq 'scriptlet failed, exit status|Error in (PREIN|POSTIN|PREUN|POSTUN) scriptlet' \
       "$BUILD_LOG"; then
    fail "image build hid an RPM scriptlet failure behind exit 0 — see $BUILD_LOG"
  else
    pass "image build contains no RPM scriptlet failures"
  fi
else
  fail "image build FAILED — see $BUILD_LOG"
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=FAIL (build)"
  exit 1
fi

sect "2. bootc container lint — against the base as a CONTROL"
# An absolute warning count is unreadable: the base ships its own. What matters is
# whether THIS image adds any, so both are measured in the same run.
base_warn=$("${PODMAN[@]}" run --rm --entrypoint /usr/bin/bootc "$BASE" container lint 2>&1 \
              | sed -n 's/^Warnings: *//p' | tail -1)
ours_warn=$("${PODMAN[@]}" run --rm --entrypoint /usr/bin/bootc "$TAG" container lint 2>&1 \
              | sed -n 's/^Warnings: *//p' | tail -1)
base_pass=$("${PODMAN[@]}" run --rm --entrypoint /usr/bin/bootc "$BASE" container lint 2>&1 \
              | sed -n 's/^Checks passed: *//p' | tail -1)
ours_pass=$("${PODMAN[@]}" run --rm --entrypoint /usr/bin/bootc "$TAG" container lint 2>&1 \
              | sed -n 's/^Checks passed: *//p' | tail -1)
if [[ -z "$base_warn" || -z "$ours_warn" ]]; then
  fail "could not read a lint verdict (base='$base_warn' ours='$ours_warn') — instrument broken, NOT a pass"
elif (( ours_warn > base_warn )); then
  fail "image adds lint warnings: base=$base_warn ours=$ours_warn"
elif (( ours_pass < base_pass )); then
  fail "image loses lint checks: base passed=$base_pass ours passed=$ours_pass"
else
  pass "no lint regression (warnings base=$base_warn ours=$ours_warn; passed base=$base_pass ours=$ours_pass)"
fi

sect "3. identities — PINNED ids, and the two refused memberships"
# The ids are a contract, not an implementation detail: /var persists across
# `bootc upgrade` while /etc/passwd comes from the image, so a renumbering
# upgrade orphans the agent's credential home. See papercusp-sysusers.conf.
while read -r who want_uid want_gid; do
  [[ -n "$who" ]] || continue
  got_uid="$(in_image "id -u $who")"
  got_gid="$(in_image "id -g $who")"
  if [[ "$got_uid" == "$want_uid" && "$got_gid" == "$want_gid" ]]; then
    pass "$who uid:gid = $got_uid:$got_gid (pinned)"
  else
    fail "$who uid:gid = '$got_uid:$got_gid', expected $want_uid:$want_gid"
  fi
done <<'IDS'
papercusp 910 910
papercusp-agent 911 911
papercusp-workspace 1500 1500
IDS
runtime_gid="$(in_image "getent group papercusp-runtime-read | cut -d: -f3")"
if [[ "$runtime_gid" == 912 ]]; then
  pass "papercusp-runtime-read gid = 912 (pinned)"
else
  fail "papercusp-runtime-read gid = '$runtime_gid', expected 912"
fi
runtime_members="$(in_image "getent group papercusp-runtime-read | cut -d: -f4 | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -")"
if [[ "$runtime_members" == "papercusp,papercusp-agent" ]]; then
  pass "immutable runtime-read group contains exactly service + agent"
else
  fail "immutable runtime-read group members are '$runtime_members', expected papercusp,papercusp-agent"
fi
for u in papercusp-workspace papercusp-agent; do
  if [[ -z "$(in_image "id -nG $u | tr ' ' '\n' | grep -Fx papercusp")" ]]; then
    pass "$u is NOT in the runtime service group"
  else
    fail "$u IS in the runtime service group — isolation contract inverted"
  fi
done
if [[ -z "$(in_image "id -nG papercusp-workspace | tr ' ' '\n' | grep -Fx papercusp-runtime-read")" ]]; then
  pass "workspace SSH user is NOT in the immutable runtime-read group"
else
  fail "workspace SSH user IS in the immutable runtime-read group — runtime exposed"
fi
runtime_root_metadata="$(in_image "stat -c '%u:%g:%a' /opt/papercusp /opt/papercusp/releases | sort -u")"
if [[ "$runtime_root_metadata" == "0:912:750" ]]; then
  pass "immutable runtime parents are root:papercusp-runtime-read 0750"
else
  fail "immutable runtime parent metadata is '$runtime_root_metadata', expected 0:912:750"
fi
if [[ "$(in_image 'getent passwd papercusp-workspace | cut -d: -f7')" == "/bin/bash" ]]; then
  pass "workspace user has a real shell (it is the customer's SSH login)"
else
  fail "workspace user shell is not /bin/bash"
fi

sect "4. packages — the substitutions and the SONAME providers"
# ufw and unattended-upgrades are NOT-IN-REPOS; minisign is EPEL-only. Their
# replacements are what the port claims, so assert the replacements are THERE
# rather than that the originals are absent.
for p in minisign nftables dnf-automatic zstd acl sudo openssh-server jq curl \
         google-compute-engine google-compute-engine-oslogin google-guest-agent \
         amazon-ssm-agent; do
  if [[ -n "$(in_image "rpm -q --qf '%{NAME}' $p 2>/dev/null | grep -Fx $p")" ]]; then
    pass "installed: $p"
  else
    fail "MISSING: $p"
  fi
done
oslogin_scriptlet="$(in_image 'rpm -q --scripts google-compute-engine-oslogin')"
for effect in \
  'systemctl enable google-oslogin-cache.timer' \
  '/sbin/ldconfig' \
  'semodule -i /usr/share/selinux/packages/oslogin.pp' \
  'restorecon -r /var/google-sudoers.d' \
  'restorecon -r /var/google-users.d' \
  'restorecon /etc/oslogin_passwd.cache.bin' \
  'restorecon /etc/oslogin_group.cache'; do
  if [[ "$oslogin_scriptlet" == *"$effect"* ]]; then
    pass "OS Login RPM scriptlet retains: $effect"
  else
    fail "OS Login RPM scriptlet lost required side effect: $effect"
  fi
done
for p in alsa-lib libatomic libgcc libstdc++ openssl-libs lz4-libs zlib libzstd; do
  if [[ -n "$(in_image "rpm -q --qf '%{NAME}' $p 2>/dev/null | grep -Fx $p")" ]]; then
    pass "SONAME provider installed: $p"
  else
    fail "MISSING SONAME provider: $p (RPM-EQUIVALENCE.md §D)"
  fi
done

sect "5. shipped files and enabled units"
for f in /etc/containers/policy.json \
         /etc/containers/registries.d/papercusp-release.yaml \
         /etc/yum.repos.d/google-cloud.repo \
         /etc/nftables/papercusp-workspace-host.nft \
         /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf \
         /usr/share/selinux/packages/oslogin.pp \
         /usr/bin/google_authorized_keys \
         /usr/lib64/security/pam_oslogin_login.so \
         /usr/lib/sysusers.d/papercusp.conf \
         /usr/libexec/papercusp/host-prepare.sh \
         /usr/lib/systemd/system/papercusp-host-prepare.service \
         /usr/lib/papercusp/base-image; do
  if [[ "$(in_image "test -e $f && echo y")" == "y" ]]; then pass "present: $f"
  else fail "MISSING: $f"; fi
done
# P-306 half B / D-284: the attested `bootc-base-image` check compares the booted host's
# recorded base against the expected one, and a BOOTED host cannot answer that question any
# other way — `bootc status` reports the ref the host booted, never what that image derives
# from, and image LABELs need a local copy of the image to inspect. So the file is the only
# source, and it must contain the ref this Containerfile actually built FROM. Compared against
# the FROM line rather than a literal, so the two cannot drift apart silently.
want_base="$(awk '/^FROM /{print $2; exit}' "$HERE/workspace-host.Containerfile")"
got_base="$(in_image "cat /usr/lib/papercusp/base-image 2>/dev/null")"
if [[ -n "$want_base" && "$got_base" == "$want_base" ]]; then
  pass "base-image provenance records the FROM base ($got_base)"
else
  fail "base-image provenance is '$got_base' but the Containerfile builds FROM '$want_base' —"\
       "the attested bootc-base-image check would compare against the wrong base"
fi
# D-262 condition 1: the policy must be the fail-closed template, not a stub.
if [[ -n "$(in_image "grep -F '<RELEASE_REGISTRY_NAMESPACE>' /etc/containers/policy.json")" ]]; then
  pass "policy.json is the fail-closed template (placeholder namespace intact)"
else
  fail "policy.json has no <RELEASE_REGISTRY_NAMESPACE> placeholder — either already"\
       "specialized by P-307, or replaced by something that may not fail closed"
fi
if [[ -n "$(in_image "grep -E '^\s*\"default\"' -A3 /etc/containers/policy.json | grep -F 'reject'")" ]]; then
  pass "policy.json default is reject"
else
  fail "policy.json default is NOT reject — it does not fail closed"
fi
# ⛔ GREPPING A POLICY IS NOT VERIFYING IT. The two checks above are TEXT assertions, and for a
# long time they were the ONLY ones touching this file — which is exactly how it shipped with a
# fatal `"_comment"` key that nobody could see. containers/image's policy parser rejects ANY
# unknown top-level key, so the image could not install itself: `bootc install to-filesystem`
# died with
#   invalid policy in "/etc/containers/policy.json": Unknown key "_comment"
# and ONLY a real disk render reaches that code path (measured 2026-09-04 by P-307's first
# end-to-end bake). `skopeo --policy` rejects it identically, so the shipped file had never been
# loadable by anything — while both greps passed the whole time. Assert loadability
# BEHAVIOURALLY; the prose that used to live in the JSON is in the sibling README.
#
# The copy is aimed at a deliberately dead registry: a policy-load failure is reported BEFORE
# the source is contacted, so "no load error" is a real verdict and not merely an absence.
polcheck() { # $1 = policy path inside the image -> count of load errors
  in_image "skopeo --policy $1 copy docker://127.0.0.1:1/nope/nope:latest dir:/tmp/polcheck 2>&1 \
            | grep -c 'Error loading trust policy'"
}
if [[ "$(polcheck /etc/containers/policy.json)" == "0" ]]; then
  pass "policy.json LOADS (containers/image accepts it)"
else
  fail "policy.json is NOT LOADABLE by containers/image — the image cannot install or upgrade"\
       "itself. An unknown top-level key (a '_comment' block, etc.) is fatal; put prose in"\
       "release-signature-policy.README.md instead"
fi
# POSITIVE CONTROL. A guard that has never failed is a guard you have not tested, and this one's
# entire job is to notice a key that looks harmless. Feed the loader the SHIPPED policy with a
# comment key planted in it: it MUST reject that. If this control ever passes, the check above
# has gone blind and its PASS proves nothing.
polctl="$(in_image "jq '. + {\"_comment\":[\"planted\"]}' /etc/containers/policy.json > /tmp/bad-policy.json 2>/dev/null; \
          skopeo --policy /tmp/bad-policy.json copy docker://127.0.0.1:1/nope/nope:latest dir:/tmp/polctl 2>&1 \
          | grep -c 'Error loading trust policy'")"
if [[ "$polctl" != "0" ]]; then
  pass "policy loadability check is FALSIFIABLE (a planted comment key is rejected)"
else
  fail "positive control FAILED: a policy with a planted '_comment' key was NOT rejected — the"\
       "loadability check above is blind, so its PASS carries no information"
fi
for u in papercusp-host-prepare.service nftables.service dnf-automatic.timer \
         sshd.service google-guest-agent.service google-oslogin-cache.timer \
         amazon-ssm-agent.service; do
  if [[ -n "$(in_image "systemctl is-enabled $u 2>/dev/null | grep -Fx enabled")" ]]; then
    pass "enabled: $u"
  else
    fail "NOT enabled: $u"
  fi
done
# WI-10005605: one image serves every cloud, so the SSM agent must be skipped off EC2
# (the drop-in), and its RPM-shipped /var/lib/amazon must not be baked (bootc lint).
ssm_condition="$(in_image "systemctl show -p ConditionFirmware --value amazon-ssm-agent.service 2>/dev/null")"
if [[ "$ssm_condition" == *'smbios-field(sys_vendor = "Amazon EC2")'* ]] \
   || [[ "$ssm_condition" == *'smbios-field(sys_vendor = Amazon EC2)'* ]]; then
  pass "amazon-ssm-agent.service is gated to EC2 firmware"
else
  fail "amazon-ssm-agent.service is NOT gated to EC2 (ConditionFirmware='$ssm_condition')"
fi
if [[ -z "$(in_image "test -e /var/lib/amazon && echo present")" ]] \
   && [[ -n "$(in_image "grep -Fx 'd /var/lib/amazon/ssm 0750 root root -' /usr/lib/tmpfiles.d/papercusp-amazon-ssm-agent.conf")" ]]; then
  pass "/var/lib/amazon/ssm comes from tmpfiles.d, not image content"
else
  fail "/var/lib/amazon is baked into the image or its tmpfiles.d entry is missing"
fi
nftables_config="$(in_image "cat /etc/sysconfig/nftables.conf")"
if [[ "$nftables_config" == 'include "/etc/nftables/papercusp-workspace-host.nft"' ]]; then
  pass "committed nftables config loads the Papercusp ruleset"
else
  fail "committed nftables config is '$nftables_config', expected the Papercusp ruleset include"
fi
if [[ "$(in_image "stat -c '%u:%g:%a:%F' /etc/sysconfig/nftables.conf")" == '0:0:600:regular file' ]]; then
  pass "committed nftables config is root:root 0600"
else
  fail "committed nftables config metadata drifted"
fi
if [[ -n "$(in_image "grep -Fx 'Requires=local-fs.target systemd-tmpfiles-setup.service nftables.service' /usr/lib/systemd/system/papercusp-host-prepare.service")" \
   && -n "$(in_image "grep -Fx 'After=local-fs.target systemd-tmpfiles-setup.service nftables.service' /usr/lib/systemd/system/papercusp-host-prepare.service")" ]]; then
  pass "host-prepare requires and follows nftables"
else
  fail "host-prepare lacks the required nftables dependency/order"
fi
# The guest agent activates OS Login dynamically from instance metadata on the
# booted host, so the image cannot honestly assert the generated sshd/PAM text.
# It can and must prove that the helper executable and readable PAM/NSS shared
# objects survived the build. Shared objects are mmap'd data and correctly ship
# 0644 (the NSS entry is a symlink); requiring `-x` is a false failure.
if [[ "$(in_image 'test -x /usr/bin/google_authorized_keys && echo y')" == "y" ]]; then
  pass "OS Login helper executable: /usr/bin/google_authorized_keys"
else
  fail "OS Login helper missing or non-executable: /usr/bin/google_authorized_keys"
fi
for f in /usr/lib64/security/pam_oslogin_login.so /usr/lib64/libnss_oslogin.so.2; do
  if [[ "$(in_image "test -r $f && echo y")" == "y" ]]; then
    pass "OS Login shared object readable: $f"
  else
    fail "OS Login shared object missing or unreadable: $f"
  fi
done
# google-compute-engine's %post must be replaced with a target-kernel dracut
# regeneration in the Containerfile: bare `dracut --force` selects the build
# host's kernel. Inspect the COMMITTED image through a file-backed listing; a
# `lsinitrd | grep -q` pipe under pipefail exits 141 after a successful early
# match and turns the guard into a false failure.
if [[ "$(in_image 'set -e; found=0; for modules_dir in /usr/lib/modules/*; do test -d "$modules_dir" || continue; found=$((found + 1)); listing=$(mktemp); lsinitrd "$modules_dir/initramfs.img" > "$listing" 2>/dev/null; grep -Fq "65-gce-disk-naming.rules" "$listing"; rm -f "$listing"; done; test "$found" -gt 0; echo y')" == "y" ]]; then
  pass "every committed initramfs carries the GCE disk-naming rule"
else
  fail "a committed initramfs lacks the GCE disk-naming rule"
fi
# google-compute-engine-oslogin's package script creates this directory while
# the image is built, but /var is machine-local on a bootc host. Shipping that
# residue is not a first-boot contract. Require the committed image to omit it,
# then exercise the boot-time tmpfiles rule in a disposable container and check
# the exact mode/owner it recreates.
if [[ "$(in_image 'test ! -e /var/google-users.d && echo y')" == "y" ]]; then
  pass "google-users.d is not committed as machine-local /var residue"
else
  fail "google-users.d is committed under /var — boot persistence is undefined"
fi
google_users_dir="$(in_image 'set -e; systemd-tmpfiles --create /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf; stat -c "%a:%u:%g" /var/google-users.d')"
if [[ "$google_users_dir" == "755:0:0" ]]; then
  pass "tmpfiles recreates google-users.d as 0755 root:root"
else
  fail "tmpfiles recreated google-users.d as '$google_users_dir', expected 755:0:0"
fi
if [[ -n "$(in_image "grep -Fx 'enabled=0' /etc/yum.repos.d/google-cloud.repo")" ]]; then
  pass "Google guest repository is build-only (enabled=0)"
else
  fail "Google guest repository is enabled at runtime — package mutation would bypass bootc"
fi
# The OS half of unattended upgrades belongs to `bootc upgrade`, not dnf: applying
# package updates in place would write to a read-only /usr and desynchronize the
# deployment from the image it claims to be.
if [[ -n "$(in_image "grep -Fx 'apply_updates = no' /etc/dnf/automatic.conf")" ]]; then
  pass "dnf-automatic is download-only (apply_updates = no)"
else
  fail "dnf-automatic would APPLY updates in place — wrong on an image-based host"
fi

sect "6. firewall ruleset parses — WITH a negative control"
# `nft --check` cannot run in the image build (no CAP_NET_ADMIN there), so it runs
# here. The negative control is the point: a checker that accepts everything would
# pass the positive case too, and prove nothing.
nftcheck() {
  "${PODMAN[@]}" run --rm --cap-add=NET_ADMIN -v "$1:/r.nft:ro,Z" \
    --entrypoint /usr/sbin/nft "$BASE" --check --file /r.nft >/dev/null 2>&1
}
if nftcheck "$HERE/papercusp-firewall.nft"; then
  pass "papercusp-firewall.nft parses"
else
  fail "papercusp-firewall.nft does NOT parse"
fi
BROKEN="$(mktemp /tmp/p306-broken.XXXXXX.nft)"
sed 's/policy drop;/policy bogus;/' "$HERE/papercusp-firewall.nft" > "$BROKEN"
if nftcheck "$BROKEN"; then
  fail "NEGATIVE CONTROL FAILED: a malformed ruleset was ACCEPTED — this check"\
       "cannot reject anything, so its pass above means nothing"
else
  pass "negative control: malformed ruleset is rejected"
fi
rm -f "$BROKEN"
for rule in 'policy drop' 'ct state established,related accept' 'iif lo accept' 'tcp dport 22 accept'; do
  if grep -qF "$rule" "$HERE/papercusp-firewall.nft"; then pass "rule present: $rule"
  else fail "rule MISSING: $rule"; fi
done

sect "7. host-prepare runs, and its last guard can actually fail"
# Run the real unit script in a privileged container. Everything up to
# identity-separation must pass; the firewall guard must FAIL, because a container
# has no nftables table loaded. That failure is the point — it is the paired
# negative control for the one assertion that protects an OPEN host, and a guard
# that passes here would be a rubber stamp.
#
# This stage is why the `install -d '/srv': File exists` bug was found at all:
# /srv is a symlink to machine-local /var/srv, and `install -d` will not descend a
# dangling one. Without the fix the unit died on EVERY boot.
prep_out="$("${PODMAN[@]}" run --rm --privileged \
  --entrypoint /usr/libexec/papercusp/host-prepare.sh "$TAG" 2>&1)"
for stage in runtime-root-is-image-content machine-local-roots runtime-group \
             workspace-acl identity-separation; do
  if grep -qF "$stage PASS" <<<"$prep_out"; then pass "host-prepare: $stage"
  else fail "host-prepare: $stage did NOT pass — output: $(grep -F "$stage" <<<"$prep_out" || echo '<absent>')"; fi
done
if grep -qF "FATAL firewall table" <<<"$prep_out"; then
  pass "host-prepare: firewall guard FIRED in a container (negative control)"
else
  fail "host-prepare: firewall guard did NOT fire without a loaded ruleset —"\
       "it cannot detect an unprotected host, so its pass on a real host is worthless"
fi

sect "8. named release-context hardlinks survive COMMIT normalization"
# Podman 4.9/Buildah can elide metadata-only upperdir entries for hardlinked
# files copied from a named context. Exercise the real release target with a
# small five-alias fixture: the source link count is the positive control, while
# the committed image must contain five fresh 0:912/0640 inodes.
RELEASE_PROBE_ROOT="$(mktemp -d /tmp/p306-release-hardlinks.XXXXXX)"
trap 'rm -rf -- "$RELEASE_PROBE_ROOT"' EXIT
RELEASE_PROBE_CONTEXT="$RELEASE_PROBE_ROOT/context"
# Keep the builder transcript outside RELEASE_PROBE_ROOT: the EXIT cleanup must
# not erase the only diagnosis when this recurrence target itself fails to build.
RELEASE_PROBE_LOG="${P306_RELEASE_BUILD_LOG:-${BUILD_LOG}.release}"
RELEASE_PROBE_TAG="${TAG}-release-hardlinks"
install -d -m 0755 "$RELEASE_PROBE_CONTEXT/hardlink tree"
printf '%s\n' 'named-context hardlink metadata sentinel' \
  > "$RELEASE_PROBE_CONTEXT/hardlink tree/primary file"
for alias in 'alias one' 'alias two' 'alias three' 'alias four'; do
  ln "$RELEASE_PROBE_CONTEXT/hardlink tree/primary file" \
     "$RELEASE_PROBE_CONTEXT/hardlink tree/$alias"
done
chown -R 1000:1000 "$RELEASE_PROBE_CONTEXT"
chmod 0644 "$RELEASE_PROBE_CONTEXT/hardlink tree"/*
if [[ "$(stat -c '%h' "$RELEASE_PROBE_CONTEXT/hardlink tree/primary file")" == "5" ]]; then
  pass "release recurrence source contains one five-name hardlink group"
else
  fail "release recurrence source fixture is not hardlinked — committed-image guard is blind"
fi
if "${PODMAN[@]}" build \
     -f "$HERE/workspace-host.Containerfile" \
     -t "$RELEASE_PROBE_TAG" \
     --target workspace-host-release \
     --build-context "papercusp-release=$RELEASE_PROBE_CONTEXT" \
     --build-arg PAPERCUSP_RELEASE_VERSION=p306-hardlink-probe \
     "$HERE" >"$RELEASE_PROBE_LOG" 2>&1; then
  pass "release target builds with named-context hardlinks"
  release_file_count="$("${PODMAN[@]}" run --rm --entrypoint /bin/bash "$RELEASE_PROBE_TAG" -c \
    "find '/opt/papercusp/releases/p306-hardlink-probe/hardlink tree' -type f -print | wc -l" 2>/dev/null)"
  release_bad_count="$("${PODMAN[@]}" run --rm --entrypoint /bin/bash "$RELEASE_PROBE_TAG" -c \
    "find '/opt/papercusp/releases/p306-hardlink-probe/hardlink tree' -type f ! \\( -uid 0 -gid 912 -perm 0640 -links 1 \\) -print | wc -l" 2>/dev/null)"
  if [[ "$release_file_count" == "5" && "$release_bad_count" == "0" ]]; then
    pass "committed release hardlinks are five distinct 0:912/0640 inodes"
  else
    fail "committed release hardlink normalization failed: files=$release_file_count bad=$release_bad_count"
  fi
  if "${PODMAN[@]}" run --rm --entrypoint /bin/bash "$RELEASE_PROBE_TAG" -c \
       "install -d -o papercusp -g papercusp -m 0750 /var/lib/papercusp \
        && stat -c '%U:%G:%a' /var/lib/papercusp | grep -Fx 'papercusp:papercusp:750' >/dev/null \
        && runuser -u papercusp -- cat '/opt/papercusp/current/hardlink tree/primary file' >/dev/null \
        && runuser -u papercusp-agent -- cat '/opt/papercusp/current/hardlink tree/primary file' >/dev/null \
        && ! runuser -u papercusp-workspace -- cat '/opt/papercusp/current/hardlink tree/primary file' >/dev/null 2>&1 \
        && runuser -u papercusp -- test -r /var/lib/papercusp \
        && runuser -u papercusp -- test -w /var/lib/papercusp \
        && runuser -u papercusp -- test -x /var/lib/papercusp \
        && ! runuser -u papercusp-agent -- test -r /var/lib/papercusp \
        && ! runuser -u papercusp-agent -- test -w /var/lib/papercusp \
        && ! runuser -u papercusp-agent -- test -x /var/lib/papercusp \
        && ! runuser -u papercusp-workspace -- test -r /var/lib/papercusp \
        && ! runuser -u papercusp-workspace -- test -w /var/lib/papercusp \
        && ! runuser -u papercusp-workspace -- test -x /var/lib/papercusp"; then
    pass "committed runtime readable by service+agent, hidden from SSH; state hidden from agent+SSH; exact state fixture accessible only to service"
  else
    fail "committed immutable runtime/state access boundary is inverted"
  fi
else
  fail "release hardlink recurrence image FAILED to build — see $RELEASE_PROBE_LOG"
fi

sect "9. the frozen P-303 spike is untouched"
# The spike artifacts booted on real GCP. The product image is written ALONGSIDE
# them; an edit to them invalidates that proof.
if grep -q "P-303 gate spike" "$HERE/Containerfile"; then
  pass "Containerfile is still the P-303 spike (not overwritten by the product image)"
else
  fail "Containerfile no longer looks like the P-303 spike — the boot proof is invalidated"
fi

echo
if (( FAILURES == 0 )); then
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=PASS"
  exit 0
else
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=FAIL failures=$FAILURES"
  exit 1
fi
