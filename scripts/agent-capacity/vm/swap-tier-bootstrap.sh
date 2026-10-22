#!/usr/bin/env bash
# Bootstrap a swap-tier test VM (WI-10005475). Run as root on the VM:
#
#   swap-tier-bootstrap.sh <claude-version>
#
# Installs fio, tmux and the zram module, creates the unprivileged `agent` user the TUIs run as
# (claude refuses bypass-permissions mode as root), and installs the pinned native claude build
# for it. Nothing here holds a credential: the agents talk to swap-tier-stub-api.py.
# For a retained P-544 lifecycle trial, after creating the admitted overflow file:
#   swap-tier-bootstrap.sh --boot-swap <zram-MiB> <lz4|zstd> <overflow-file> <overflow-bytes>
# This explicit trial policy uses the product's systemd-zram-generator mechanism.
# It does not change the product's ram/2 + zstd default or allocate another disk.
# Lines to grep: BOOTSTRAP_*.

install_boot_swap() {
  local size="$1" algorithm="$2" overflow="$3" bytes="$4"
  local conf="${5:-/etc/systemd/zram-generator.conf}"
  local sysctl_conf="${6:-/etc/sysctl.d/90-papercusp-zram.conf}" fstab="${7:-/etc/fstab}"
  local marker='# Managed P544 qualification boot swap.' entry existing packaged_md5 actual_md5 restart=1
  [[ "$size" =~ ^[1-9][0-9]{0,6}$ && "$size" -le 1048576 && "$bytes" =~ ^[1-9][0-9]{0,15}$ ]] || return 1
  [[ "$algorithm" == lz4 || "$algorithm" == zstd ]] || return 1
  [[ "$overflow" =~ ^/[A-Za-z0-9_./-]+$ && -f "$overflow" && ! -L "$overflow" ]] || return 1
  [[ "$(stat -c %s -- "$overflow")" == "$bytes" ]] || return 1
  # Never reconfigure swap below an active measured cohort.
  if systemctl is-active --quiet swaptier.slice; then
    echo 'BOOTSTRAP_ERROR stop measured agents before configuring boot swap' >&2
    return 1
  fi
  if [[ -e "$conf" ]] && ! grep -qxF "$marker" "$conf"; then
    packaged_md5="$(dpkg-query -s systemd-zram-generator 2>/dev/null | awk -v conf="$conf" '$1 == conf { print $2 }' || true)"
    actual_md5="$(md5sum -- "$conf" | cut -d ' ' -f 1)"
    [[ "$packaged_md5" =~ ^[a-f0-9]{32}$ && "$actual_md5" == "$packaged_md5" ]] || {
      echo 'BOOTSTRAP_ERROR foreign zram generator configuration' >&2; return 1;
    }
  fi
  entry="$overflow none swap defaults,pri=10 0 0"
  existing="$(awk -v file="$overflow" '$1 == file { print }' "$fstab")"
  [[ -z "$existing" || "$existing" == "$entry" ]] || {
    echo 'BOOTSTRAP_ERROR conflicting overflow fstab entry' >&2; return 1;
  }
  # Retire only the obsolete experiment unit, when it exists. No manual zramctl reset.
  if systemctl cat p544-swap.service >/dev/null 2>&1; then
    systemctl disable --now p544-swap.service || return 1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd-zram-generator || return 1
  install -d -m 0755 -- "$(dirname -- "$conf")" "$(dirname -- "$sysctl_conf")"
  printf '%s\n' "$marker" '[zram0]' "zram-size = $size" "compression-algorithm = $algorithm" 'swap-priority = 100' > "$conf.next"
  if cmp -s -- "$conf.next" "$conf"; then restart=0; fi
  mv -f -- "$conf.next" "$conf"
  printf '%s\n' "$marker" 'vm.page-cluster = 0' > "$sysctl_conf"
  if [[ -z "$existing" ]]; then printf '\n%s\n' "$entry" >> "$fstab"; fi
  # Generate units BEFORE stopping one: on the first install it may not exist yet.
  systemctl daemon-reload || return 1
  # This independent fstab-generated unit must start even if compressed swap fails.
  systemctl start "$(systemd-escape --path --suffix=swap "$overflow")" || return 1
  if [[ "$restart" -eq 1 ]]; then
    systemctl stop dev-zram0.swap || return 1
    systemctl stop systemd-zram-setup@zram0.service || return 1
  fi
  systemctl start dev-zram0.swap || return 1
  sysctl -q -p "$sysctl_conf" || return 1
  echo "BOOTSTRAP_BOOT_SWAP configured zramMiB=$size algorithm=$algorithm overflowBytes=$bytes"
}

# Source only the installer in the shell regression harness; it supplies scratch paths.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi
if [[ "${1:-}" == --boot-swap ]]; then
  set -euo pipefail
  [[ "$EUID" -eq 0 && "$#" -eq 5 ]] || { echo 'BOOTSTRAP_ERROR boot swap requires root and four policy arguments' >&2; exit 1; }
  install_boot_swap "$2" "$3" "$4" "$5"
  exit "$?"
fi
set -uo pipefail
V=${1:?usage: swap-tier-bootstrap.sh <cli-version> [claude|codex]}
CLI=${2:-claude}
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null || { echo "BOOTSTRAP_ERROR apt-get update"; exit 1; }
apt-get install -y -q fio tmux zstd >/dev/null || { echo "BOOTSTRAP_ERROR apt-get install"; exit 1; }
# zram ships in linux-modules-extra on some Ubuntu kernel flavours; try the base package first.
modprobe zram 2>/dev/null || apt-get install -y -q "linux-modules-extra-$(uname -r)" >/dev/null 2>&1
if modprobe zram; then echo "BOOTSTRAP_ZRAM ok"; else echo "BOOTSTRAP_ERROR zram module missing for $(uname -r)"; exit 1; fi
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
if [[ "$CLI" == codex ]]; then
  # Codex's bundled bwrap helper cannot create the required network namespace on
  # Ubuntu 24.04 with restricted user namespaces. Use the distro binary/profile,
  # as documented at https://developers.openai.com/codex/sandboxing.
  apt-get install -y -q nodejs npm bubblewrap apparmor-profiles apparmor-utils >/dev/null || { echo "BOOTSTRAP_ERROR codex dependencies"; exit 1; }
  profile=/etc/apparmor.d/bwrap-userns-restrict
  if [[ ! -f "$profile" && -f /usr/share/apparmor/extra-profiles/bwrap-userns-restrict ]]; then
    install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict "$profile"
  fi
  if [[ -f "$profile" ]]; then
    apparmor_parser -r "$profile" || { echo "BOOTSTRAP_ERROR bwrap profile"; exit 1; }
  fi
  npm install --global "@openai/codex@$V" >/dev/null 2>&1 || { echo "BOOTSTRAP_ERROR codex install"; exit 1; }
  got=$(codex --version)
  [[ "$got" == "codex-cli $V" ]] || { echo "BOOTSTRAP_ERROR codex version $got"; exit 1; }
  echo "BOOTSTRAP_CODEX $got"
  echo "BOOTSTRAP_DONE kernel=$(uname -r)"
  exit 0
fi
[[ "$CLI" == claude ]] || { echo "BOOTSTRAP_ERROR unknown CLI $CLI"; exit 1; }
sudo -u agent -H bash -c "curl -fsSL https://claude.ai/install.sh | bash -s $V" >/dev/null 2>&1
got=$(sudo -u agent -H /home/agent/.local/bin/claude --version 2>&1 | head -1)
case "$got" in "$V"*) echo "BOOTSTRAP_CLAUDE $got" ;; *) echo "BOOTSTRAP_ERROR claude version '$got' != $V"; exit 1 ;; esac
echo "BOOTSTRAP_DONE kernel=$(uname -r) swap=$(swapon --show=NAME --noheadings | tr '\n' ' ')"
