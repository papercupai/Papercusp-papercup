#!/usr/bin/env bash
# P-304 verification probe. Runs INSIDE quay.io/centos-bootc/centos-bootc:stream9 — the exact
# base D-254 targets — and reports, for each Ubuntu-24.04 assumption the rendered bootstrap
# carries, what actually exists on the RPM family.
#
# Every line is an OBSERVATION from this base, not a translation. `dnf provides` is asked for the
# SONAME providers specifically because the source comment forbids guessing them.
set -uo pipefail

hr() { printf '\n== %s ==\n' "$1"; }
probe_cmd() {
  local name="$1" p
  p="$(command -v "$name" 2>/dev/null)"
  if [ -n "$p" ]; then printf 'CMD\t%s\tPRESENT\t%s\n' "$name" "$p"
  else printf 'CMD\t%s\tABSENT\t-\n' "$name"; fi
}
probe_path() {
  local p="$1"
  if [ -e "$p" ]; then printf 'PATH\t%s\tPRESENT\n' "$p"
  else printf 'PATH\t%s\tABSENT\n' "$p"; fi
}
probe_soname() {
  local so="$1" out pkg
  out="$(dnf -q provides "${so}()(64bit)" 2>/dev/null | head -1)"
  pkg="$(printf '%s' "$out" | awk '{print $1}')"
  if [ -n "$pkg" ]; then printf 'SONAME\t%s\t%s\n' "$so" "$pkg"
  else printf 'SONAME\t%s\tNO-PROVIDER\n' "$so"; fi
}
probe_rpmpkg() {
  local p="$1"
  if dnf -q list --installed "$p" >/dev/null 2>&1; then printf 'PKG\t%s\tINSTALLED\n' "$p"
  elif dnf -q list --available "$p" >/dev/null 2>&1; then printf 'PKG\t%s\tAVAILABLE\n' "$p"
  else printf 'PKG\t%s\tNOT-IN-REPOS\n' "$p"; fi
}

hr "BASE IDENTITY (the /etc/os-release check the bootstrap hardcodes)"
. /etc/os-release
printf 'OSRELEASE\tID=%s\tVERSION_ID=%s\tPRETTY=%s\n' "$ID" "$VERSION_ID" "$PRETTY_NAME"

hr "IDENTITY + ACL + PRIVILEGE PRIMITIVES"
for c in useradd usermod groupadd setfacl getfacl runuser visudo sudo sshd systemctl chpasswd; do probe_cmd "$c"; done
for p in /usr/sbin/nologin /sbin/nologin /usr/sbin/runuser /usr/sbin/useradd /usr/sbin/usermod /usr/sbin/groupadd /usr/bin/setfacl /usr/bin/sudo /usr/sbin/visudo; do probe_path "$p"; done

hr "FLAG SEMANTICS - the flags the bootstrap actually passes"
useradd --help 2>&1 | grep -qE -- '--system' && printf 'FLAG\tuseradd --system\tSUPPORTED\n' || printf 'FLAG\tuseradd --system\tMISSING\n'
usermod --help 2>&1 | grep -qE -- '--lock' && printf 'FLAG\tusermod --lock\tSUPPORTED\n' || printf 'FLAG\tusermod --lock\tMISSING\n'
useradd --help 2>&1 | grep -qE -- '--no-create-home' && printf 'FLAG\tuseradd --no-create-home\tSUPPORTED\n' || printf 'FLAG\tuseradd --no-create-home\tMISSING\n'
useradd --help 2>&1 | grep -qE -- '--shell' && printf 'FLAG\tuseradd --shell\tSUPPORTED\n' || printf 'FLAG\tuseradd --shell\tMISSING\n'

hr "sshd_config.d INCLUDE - does the shipped sshd_config actually read the drop-in dir?"
if [ -f /etc/ssh/sshd_config ]; then
  if grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    printf 'SSHD_INCLUDE\tPRESENT\n'
    printf 'SSHD_INCLUDE_LINE\t%s\n' "$(grep -nE '^[[:space:]]*Include' /etc/ssh/sshd_config | head -1)"
    printf 'SSHD_TOTAL_LINES\t%s\n' "$(wc -l < /etc/ssh/sshd_config)"
  else
    printf 'SSHD_INCLUDE\tABSENT-OR-NOT-DEFAULT\n'
  fi
else
  printf 'SSHD_INCLUDE\tNO-SSHD_CONFIG (openssh-server not installed in base)\n'
fi
probe_path /etc/ssh/sshd_config.d

hr "LIVE ACL BEHAVIOUR (D-251 named-user ACLs - the class D-246 warns silently differs)"
mkdir -p /tmp/p304acl && echo x > /tmp/p304acl/f
NOLOGIN=/usr/sbin/nologin; [ -e "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
useradd --system --no-create-home --shell "$NOLOGIN" p304probe 2>/dev/null
printf 'PROBE_USER_CREATED\t%s\n' "$(id -u p304probe 2>/dev/null || echo FAILED)"
if setfacl -m u:p304probe:rx /tmp/p304acl 2>/dev/null; then
  printf 'ACL_SETFACL_NAMED_USER\tOK\n'
  getfacl -p /tmp/p304acl 2>/dev/null | sed 's/^/ACL_GETFACL\t/'
else
  printf 'ACL_SETFACL_NAMED_USER\tFAILED\n'
fi
if setfacl -d -m u:p304probe:rx /tmp/p304acl 2>/dev/null; then printf 'ACL_DEFAULT_INHERIT\tOK\n'; else printf 'ACL_DEFAULT_INHERIT\tFAILED\n'; fi
if runuser -u p304probe -- /bin/true >/dev/null 2>&1; then printf 'RUNUSER_EXPLICIT_ARGV\tOK\n'; else printf 'RUNUSER_EXPLICIT_ARGV\tFAILED\n'; fi

hr "SONAME PROVIDERS - RE-DERIVED from the RPM package DB, never translated"
for so in libasound.so.2 libatomic.so.1 libgcc_s.so.1 liblz4.so.1 libssl.so.3 'libstdc++.so.6' libz.so.1 libzstd.so.1; do probe_soname "$so"; done

hr "GLIBC BASELINE SONAMES - present on this base without packaging?"
for so in ld-linux-x86-64.so.2 libc.so.6 libdl.so.2 libm.so.6 libpthread.so.0 librt.so.1 libutil.so.1 libresolv.so.2; do
  if ldconfig -p 2>/dev/null | grep -qE "^[[:space:]]*${so//./\\.} "; then printf 'GLIBC\t%s\tPRESENT\n' "$so"; else printf 'GLIBC\t%s\tNOT-IN-LDCACHE\n' "$so"; fi
done

hr "SYSTEM PACKAGE EQUIVALENTS - availability in this base's repos"
for p in acl bubblewrap ca-certificates curl git-core jq openssh-server sudo minisign firewalld nftables dnf-automatic; do probe_rpmpkg "$p"; done

hr "PACKAGES WITH NO RPM EQUIVALENT (expect NOT-IN-REPOS - substitution required)"
for p in ufw unattended-upgrades; do probe_rpmpkg "$p"; done
