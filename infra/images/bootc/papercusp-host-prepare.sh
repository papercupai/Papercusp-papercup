#!/usr/bin/bash
#
# P-306 — workspace-host preparation, run on EVERY boot by
# `papercusp-host-prepare.service`.
#
# This is the half of the generated bootstrap's `harden-os` phase that CANNOT
# become an image layer. Everything else moved into
# `workspace-host.Containerfile`. Two measured reasons put the MUTABLE lines here
# and not there, and neither is a style preference:
#
#  1. POSIX ACLs DO NOT SURVIVE A CONTAINER COMMIT (WI-2143115). This still means
#     the machine-local workspace ACL must be applied here. It CANNOT mean an ACL
#     on `/opt`: the first real P-305 boot proved `/opt` is immutable/read-only,
#     so that write fails with EROFS. D-314 instead bakes immutable runtime access
#     as a dedicated supplementary group and this unit verifies it read-only.
#
#  2. `/srv` AND `/home` ARE SYMLINKS INTO MACHINE-LOCAL `/var` on this base
#     (measured 2026-09-04 against centos-bootc:stream9: `srv -> var/srv`,
#     `home -> var/home`). Content written there in a layer is not image content
#     and does not reach a deployed host at all.
#
# ── Why EVERY boot rather than first ──────────────────────────────────────────
# `/opt` is immutable image content and is replaced by `bootc upgrade`; its group
# metadata must already be correct in every signed image. `/var` and `/srv` are
# machine-local and persist, so their directory and ACL work remains idempotent
# on every boot. Making that mutable work once-only would break upgraded hosts.
#
# ── Source of truth ───────────────────────────────────────────────────────────
# Every path, mode, owner and ACL below is transcribed from the `harden-os` phase
# of `libs/generic/deployment-driver/src/workspace-host-bootstrap.ts`. When that
# changes, this changes. It is a PIN, not a derivation — the bootc host model's
# equivalent of the check-evidence map, and it drifts if nobody looks.

set -euo pipefail

SERVICE_USER=papercusp
SERVICE_GROUP=papercusp
WORKSPACE_USER=papercusp-workspace
WORKSPACE_GROUP=papercusp-workspace
AGENT_USER=papercusp-agent
AGENT_GROUP=papercusp-agent
RUNTIME_READ_GROUP=papercusp-runtime-read

RUNTIME_ROOT=/opt/papercusp
STATE_ROOT=/var/lib/papercusp
WORKSPACE_ROOT=/srv/papercusp/workspaces
AGENT_HOME="/home/$AGENT_USER"

# Each line is a distinct greppable assertion on the serial console, which is the
# only channel a converted cloud disk image offers before SSH is up. Same shape as
# p303-boot-proof.service, deliberately: the boot test greps for these.
say() { echo "PAPERCUSP-HOST-PREPARE: $*"; }
die() { echo "PAPERCUSP-HOST-PREPARE: FATAL $*" >&2; exit 1; }

say "start os=$(. /etc/os-release; echo "$ID-$VERSION_ID") kernel=$(uname -r)"

# ── 0. The assertion this whole file exists to make loud ──────────────────────
#
# Is the runtime root actually IMAGE content on the deployed host?
#
# `/opt` is a real directory in the image, and the base's tmpfiles dropin
# (`rpm-ostree-0-integration-opt-usrlocal.conf`) says in its own comment that it
# "implements the old model", where `/opt` is a link to `/var/opt`. Those two
# facts disagree, and no container-level probe can settle which one the DEPLOYED
# host follows — a container always shows the image's view.
#
# If the deployed host resolves `/opt` to machine-local storage, the release tree
# baked into the image is ABSENT, the host has no runtime at all, and without this
# check it would keep booting and report healthy. Fail closed and say which of the
# two models the host actually implements, because that answer is what P-305 owes
# a booted assertion for and what decides whether the baked-release design holds.
if [[ -L /opt ]]; then
  die "/opt is a SYMLINK to $(readlink -f /opt) on this deployment — the base's" \
      "'old model'. A release tree baked into the image does NOT reach this host." \
      "The bootc port's baked-runtime design does not hold here; see" \
      "infra/images/bootc/workspace-host.Containerfile layer 7."
fi
if [[ ! -d "$RUNTIME_ROOT" ]]; then
  die "$RUNTIME_ROOT is absent on the booted deployment although the image" \
      "created it — /opt did not survive as image content."
fi
say "runtime-root-is-image-content PASS ($RUNTIME_ROOT present, /opt is a real directory)"

# ── 0.5. OS Login SELinux policy — the RPM %post cannot commit it in the image overlay ──
# Keep the package scriptlets enabled in the Containerfile: they still enable the cache timer,
# refresh ldconfig and perform their restorecon passes. Buildah's image overlay rejects the
# scriptlet's semodule rename, so install the shipped policy against the booted host's persistent
# policy store, then replay the scriptlet's labels after the OS Login file contexts are available.
OSLOGIN_POLICY=/usr/share/selinux/packages/oslogin.pp
[[ -r "$OSLOGIN_POLICY" ]] || die "OS Login SELinux policy is absent or unreadable: $OSLOGIN_POLICY"
command -v semodule >/dev/null 2>&1 || die "semodule is missing; cannot install OS Login SELinux policy"
say "oslogin-policy install start"
semodule -i "$OSLOGIN_POLICY" || die "semodule failed to install OS Login SELinux policy"
if ! semodule -lfull | awk '$2 == "oslogin" { found = 1 } END { exit !found }'; then
  die "OS Login SELinux policy is not present after semodule install"
fi
for path in /var/google-sudoers.d /var/google-users.d; do
  if [[ -e "$path" ]]; then restorecon -r "$path"; fi
done
for path in /etc/oslogin_passwd.cache.bin /etc/oslogin_group.cache; do
  if [[ -e "$path" ]]; then restorecon "$path"; fi
done
say "oslogin-policy PASS (module installed and RPM restorecon effects applied)"

# ── 1. Machine-local roots ────────────────────────────────────────────────────
# Baked equivalents would be discarded: /var is machine-local state on a bootc
# host and /srv + /home are symlinks into it.

# ⚠ Materialize those symlink TARGETS before anything writes through them.
#
# `/srv -> /var/srv` and `/home -> /var/home`, and on a fresh deployment the
# targets need not exist yet. `install -d` does not treat a dangling symlink as a
# directory to descend: for an intermediate component it calls mkdir(), gets
# EEXIST from the symlink itself, and fails hard with "cannot create directory
# '/srv': File exists". `mkdir -p` fails the same way, because it then stats a
# path that does not resolve.
#
# Measured, running this script in the built image: without these two lines the
# unit dies at the first `install -d` on EVERY boot, so the host comes up with no
# workspace root at all — and the failure names /srv, which reads like a
# filesystem problem rather than an ordering one.
for link in /srv /home; do
  if [[ -L "$link" ]]; then
    mkdir -p -- "$(readlink -f "$link")"
  fi
done

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$STATE_ROOT" "$STATE_ROOT/embedded-pg"
install -d -o root -g "$SERVICE_GROUP" -m 0750 /etc/papercusp
install -d -o root -g root -m 0711 /srv/papercusp
install -d -o root -g root -m 0770 "$WORKSPACE_ROOT"
install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER"
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"
say "machine-local-roots PASS"

# ── 2. Immutable runtime metadata — VERIFY ONLY, NEVER MUTATE /opt ─────────────
# The service and agent share only this narrow capability group. The service's
# primary `$SERVICE_GROUP` continues to gate state/credentials, while the
# agent's primary `$AGENT_GROUP` continues to gate its credential home.
[[ "$(getent group "$RUNTIME_READ_GROUP" | cut -d: -f3)" == 912 ]] \
  || die "$RUNTIME_READ_GROUP is absent or no longer pinned to gid 912"
for user in "$SERVICE_USER" "$AGENT_USER"; do
  id -nG "$user" | tr ' ' '\n' | grep -Fx "$RUNTIME_READ_GROUP" >/dev/null \
    || die "$user is not in immutable runtime-read group $RUNTIME_READ_GROUP"
done
runtime_member_count="$(getent group "$RUNTIME_READ_GROUP" | cut -d: -f4 | tr ',' '\n' | sed '/^$/d' | wc -l)"
[[ "$runtime_member_count" == 2 ]] \
  || die "$RUNTIME_READ_GROUP has $runtime_member_count supplementary members, expected exactly 2"
if id -nG "$WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$RUNTIME_READ_GROUP" >/dev/null; then
  die "workspace SSH user belongs to immutable runtime-read group $RUNTIME_READ_GROUP"
fi
for path in "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"; do
  [[ "$(stat -c '%U:%G:%a' "$path")" == "root:$RUNTIME_READ_GROUP:750" ]] \
    || die "$path immutable metadata is $(stat -c '%U:%G:%a' "$path"), expected root:$RUNTIME_READ_GROUP:750"
done
for user in "$SERVICE_USER" "$AGENT_USER"; do
  runuser -u "$user" -- test -r "$RUNTIME_ROOT/releases" \
    && runuser -u "$user" -- test -x "$RUNTIME_ROOT/releases" \
    || die "$user cannot read/traverse immutable runtime releases"
done
if runuser -u "$WORKSPACE_USER" -- test -r "$RUNTIME_ROOT/releases"; then
  die "workspace SSH user can read immutable runtime releases"
fi
if getfacl -cp "$RUNTIME_ROOT" 2>/dev/null | grep -q '^user:papercusp-agent:'; then
  die "immutable runtime still relies on a named-user ACL instead of image metadata"
fi
if [[ -L "$RUNTIME_ROOT/current" ]]; then
  release_dir="$(readlink -f "$RUNTIME_ROOT/current")"
  [[ "$release_dir" == "$RUNTIME_ROOT/releases/"* ]] \
    || die "current runtime resolves outside $RUNTIME_ROOT/releases"
  [[ "$(stat -c '%U:%G:%a' "$release_dir")" == "root:$RUNTIME_READ_GROUP:750" ]] \
    || die "$release_dir immutable metadata is $(stat -c '%U:%G:%a' "$release_dir"), expected root:$RUNTIME_READ_GROUP:750"
  [[ -z "$(find "$release_dir" -xdev ! -group "$RUNTIME_READ_GROUP" -print -quit)" ]] \
    || die "immutable release tree contains an entry outside $RUNTIME_READ_GROUP"
fi
say "runtime-group PASS"

# ── 3. Workspace root: the three-way shared ACL ───────────────────────────────
# Cleared first so a re-run cannot accumulate stale entries from an earlier image.
setfacl --remove-all "$WORKSPACE_ROOT"
setfacl --remove-default "$WORKSPACE_ROOT"
# Service, SSH account and agent all read/write the scoped workspace root, and the
# default ACL makes new files inherit that — which is what lets the customer edit
# over SSH what the agent wrote, with neither side chown-ing. `o::---` keeps
# everyone else out; the mask must be rwx or it clamps the named entries.
setfacl    -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"
setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"

getfacl -p "$WORKSPACE_ROOT" 2>/dev/null | grep -q "^default:user:$AGENT_USER:rwx" \
  || die "workspace-root DEFAULT ACL did not take effect; files created there" \
         "would not be shared between the SSH account and the agent identity"
say "workspace-acl PASS"

# ── 4. Negative membership, re-asserted on the booted host ────────────────────
# The image build already refuses these, but the check is cheap and the property
# is the one that decides whether platform credentials are exposed to the
# customer's SSH login. A host that somehow acquired the membership should refuse
# to present itself as healthy.
if id -nG "$WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$SERVICE_GROUP" >/dev/null; then
  die "workspace SSH user belongs to the runtime service group"
fi
say "identity-separation PASS"

# ── 5. The firewall is actually LOADED ────────────────────────────────────────
#
# This is the assertion the image build could not make (no CAP_NET_ADMIN there),
# and it guards the direction that actually hurts. A default-deny ruleset that
# fails to load does not leave the host closed — it leaves it with NO rules, so
# every port the service binds is reachable from the network while sshd, the
# service and the attestation all still read healthy. "Absent" is the dangerous
# failure here, not "malformed".
if ! nft list table inet papercusp_workspace_host >/dev/null 2>&1; then
  die "firewall table 'inet papercusp_workspace_host' is NOT loaded — the host is" \
      "accepting traffic on every bound port. Check nftables.service:" \
      "systemctl status nftables.service"
fi
say "firewall-loaded PASS"

say "complete"
