#!/usr/bin/env bash
# Reach a hosted GCP workspace VM as the customer account papercusp-workspace, the way the
# controller does (memory d6d4856e). usage: vmssh.sh <instance> <project> <zone> <remote command>
set -euo pipefail
inst="$1"; project="$2"; zone="$3"; shift 3
state="$HOME/.local/state/papercusp/controller"
prefix="gcp-iap-$(printf '%s\0%s\0%s' "$project" "$zone" "$inst" | sha256sum | cut -c1-32)"
alias_line="$(grep -o "${prefix}-[0-9]*" "$state/known_hosts" | head -n 1 || true)"
[ -n "$alias_line" ] || { echo "VMSSH_NO_HOST_KEY prefix=$prefix" >&2; exit 3; }
exec ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$state/known_hosts" -o HostKeyAlias="$alias_line" \
  -o IdentitiesOnly=yes -i "$state/id_ed25519" -o ConnectTimeout=40 \
  -o "ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=$project --zone=$zone --verbosity=error" \
  "papercusp-workspace@$inst" "$@"
