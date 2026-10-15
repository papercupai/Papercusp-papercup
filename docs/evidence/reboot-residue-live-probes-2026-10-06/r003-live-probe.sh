#!/usr/bin/env bash
# reboot-residue R-003 live probe (AUTO-BAR-R-003-P-003@5) — vboxdrv via Oracle virtualbox-7.2 + kernel hook.
set -u
echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
K=$(uname -r); echo "uname_r=$K"
dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' virtualbox-7.2 virtualbox-dkms 2>&1 | sed 's/^/dpkg /'
P=$(modinfo -n vboxdrv 2>&1); echo "modinfo_n=$P"
case "$P" in /lib/modules/$K/*|/usr/lib/modules/$K/*) echo UNDER_RUNNING_KERNEL=yes;; *) echo UNDER_RUNNING_KERNEL=no;; esac
VM=$(modinfo -F vermagic vboxdrv 2>&1); echo "vermagic=$VM"
[ "$(echo "$VM" | awk '{print $1}')" = "$K" ] && echo VERMAGIC_MATCH=yes || echo VERMAGIC_MATCH=no
lsmod | awk '$1 ~ /^vbox/ {print "lsmod", $1, $2, $3}'
echo "LSMOD_HAS_VBOXDRV=$(lsmod | awk '$1=="vboxdrv"' | wc -l)"
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
REPO=$ROOT/apps/operator/scripts/systemd/vboxdrv-rebuild.kernel-hook
echo "repo_hook_sha=$(sha256sum "$REPO" | cut -c1-64)"
for d in /etc/kernel/postinst.d /etc/kernel/header_postinst.d; do
  for f in $(ls "$d" 2>/dev/null | grep -i vbox); do
    h="$d/$f"; s=$(sha256sum "$h" | cut -c1-64)
    x=$([ -x "$h" ] && echo exec || echo NOEXEC)
    cmp -s "$h" "$REPO" && same=identical || same=DIFFERENT
    echo "hook $h $x $same $s"
  done
  echo "runparts_select[$d]: $(run-parts --test "$d" 2>/dev/null | grep -i vbox | tr '\n' ' ')"
done
cd "$ROOT" || exit 1
git log -1 --format='repo_hook_commit=%H %cI' -- apps/operator/scripts/systemd/vboxdrv-rebuild.kernel-hook
echo "repo_hook_dirty=$(git status --porcelain -- apps/operator/scripts/systemd/vboxdrv-rebuild.kernel-hook | wc -l)"
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
