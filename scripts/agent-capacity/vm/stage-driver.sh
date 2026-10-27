#!/usr/bin/env bash
# Stage the agent-capacity driver onto a capacity VM (plan agent-capacity-and-cost-gcp-2026-09-30).
# Run from anywhere on the tower, BEFORE bootstrap-agent-vm.sh runs on the VM:
#
#   bash scripts/agent-capacity/vm/stage-driver.sh <vm> <project> <zone>
#
# The VM runs the driver from ~/capacity with its own node_modules (tsx only), not from the monorepo,
# so a plain copy of scripts/agent-capacity/*.ts loses every workspace import. P-529 (2026-10-01)
# lost two runs to it: session-process.ts's `@papercusp/operator-core/lib/child-output` did not
# resolve, then the corpus/ dir (the driver's default tasks.json) was missing. This copies:
#   - scripts/agent-capacity/*.ts (not tests), corpus/, vm/*.sh and vm/*.py
#   - every `@papercusp/operator-core/<path>` module those scripts import, as
#     ~/capacity/scripts/node_modules/@papercusp/operator-core/<path>.ts (tsx resolves the bare
#     specifier by walking up from scripts/agent-capacity/). NOT ~/capacity/node_modules: npm owns
#     that dir, and the bring-up's `npm init -y && npm install tsx@4` there prunes an undeclared
#     package, which failed two ramp preflights (WI-10005355). npm never touches scripts/node_modules,
#     so staging order no longer matters.
# and refuses an imported module that itself imports anything but node:* (its own closure would be
# missing on the VM). p005-ramp.sh's `load-driver.ts --check` preflight is the backstop on the VM.
# STAGE_ROOT overrides the repo root (tests). Lines to grep: STAGE_*.
set -uo pipefail
VM=${1:?usage: stage-driver.sh <vm> <project> <zone>}
PROJECT=${2:?usage: stage-driver.sh <vm> <project> <zone>}
ZONE=${3:?usage: stage-driver.sh <vm> <project> <zone>}
ROOT=${STAGE_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}
cd "$ROOT" || exit 1
S=scripts/agent-capacity

mapfile -t ts < <(find "$S" -maxdepth 1 -name '*.ts' ! -name '*.test.ts' | sort)
[ "${#ts[@]}" -gt 0 ] || { echo "STAGE_ERROR no driver scripts under $ROOT/$S"; exit 2; }
[ -f "$S/corpus/tasks.json" ] || { echo "STAGE_ERROR no $S/corpus/tasks.json"; exit 2; }

# Module specifiers in `from '…'` clauses (single- or multi-line imports and re-exports).
specs() { grep -ohE "from '[^']+'" "$@" | sed -E "s/^from '(.*)'$/\1/" | sort -u; }
mapfile -t mods < <(specs "${ts[@]}" | sed -n 's#^@papercusp/operator-core/##p')
for m in "${mods[@]}"; do
  f="packages/operator-core/$m.ts"
  [ -f "$f" ] || { echo "STAGE_ERROR $f (imported as @papercusp/operator-core/$m) does not exist"; exit 2; }
  extra=$(specs "$f" | grep -v '^node:' | tr '\n' ' ')
  [ -z "$extra" ] || { echo "STAGE_ERROR $f imports $extra- not a leaf module, so the VM copy would not resolve; stage its closure or drop the import"; exit 2; }
done

# Bind the bytes being copied, including working-tree edits, to their VM paths. A checkout
# SHA alone identifies neither these measurement writers nor their staged operator-core copies.
manifest=$(mktemp) || exit 2
trap 'rm -f "$manifest"' EXIT
{
  for f in "${ts[@]}" "$S"/corpus/* "$S"/vm/*.sh "$S"/vm/*.py; do
    sha=$(sha256sum "$f") || exit 2
    printf '%s  %s\n' "${sha%% *}" "$f"
  done
  for m in "${mods[@]}"; do
    sha=$(sha256sum "packages/operator-core/$m.ts") || exit 2
    printf '%s  scripts/node_modules/@papercusp/operator-core/%s.ts\n' "${sha%% *}" "$m"
  done
} > "$manifest" || { echo "STAGE_ERROR writer manifest"; exit 2; }
manifest_sha=$(sha256sum "$manifest") || exit 2
manifest_sha=${manifest_sha%% *}

ssh_vm() { gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --command="$1"; }
scp_vm() { gcloud compute scp --project="$PROJECT" --zone="$ZONE" --quiet "$@"; }
NM=capacity/scripts/node_modules/@papercusp/operator-core
dirs="~/capacity/scripts/agent-capacity/vm ~/capacity/scripts/agent-capacity/corpus ~/capacity/p529 ~/capacity/fp"
for m in "${mods[@]}"; do dirs="$dirs ~/$NM/$(dirname "$m")"; done
ssh_vm "mkdir -p $dirs && printf '{\"name\":\"@papercusp/operator-core\",\"version\":\"0.0.0-vm\"}\n' > ~/$NM/package.json" \
  || { echo "STAGE_ERROR ssh"; exit 3; }
scp_vm "${ts[@]}" "$VM:capacity/$S/" || { echo "STAGE_ERROR copy scripts"; exit 4; }
scp_vm "$S"/corpus/* "$VM:capacity/$S/corpus/" || { echo "STAGE_ERROR copy corpus"; exit 4; }
scp_vm "$S"/vm/*.sh "$S"/vm/*.py "$VM:capacity/$S/vm/" || { echo "STAGE_ERROR copy vm"; exit 4; }
for m in "${mods[@]}"; do
  scp_vm "packages/operator-core/$m.ts" "$VM:$NM/$m.ts" || { echo "STAGE_ERROR copy $m"; exit 4; }
done
scp_vm "$manifest" "$VM:capacity/stage-writers.sha256" || { echo "STAGE_ERROR copy writer manifest"; exit 4; }
ssh_vm "cd ~/capacity && printf '%s  stage-writers.sha256\n' '$manifest_sha' | sha256sum -c - && sha256sum -c stage-writers.sha256" \
  || { echo "STAGE_ERROR writer verification"; exit 5; }
echo "STAGE_WRITERS vm=$VM manifestSha256=$manifest_sha"
echo "STAGE_OK vm=$VM scripts=${#ts[@]} operatorCore=${#mods[@]}${mods[*]:+ (${mods[*]})}"
