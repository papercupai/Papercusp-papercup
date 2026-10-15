#!/usr/bin/env bash
# Bootstrap a swap-tier test VM (WI-10005475). Run as root on the VM:
#
#   swap-tier-bootstrap.sh <claude-version>
#
# Installs fio, tmux and the zram module, creates the unprivileged `agent` user the TUIs run as
# (claude refuses bypass-permissions mode as root), and installs the pinned native claude build
# for it. Nothing here holds a credential: the agents talk to swap-tier-stub-api.py.
# Lines to grep: BOOTSTRAP_*.
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
