#!/usr/bin/env bash
# P-012 probe (voice-two-tier-elevenlabs-agent-2026-10-06, SPEC-P-012).
#
# Clause: the final release item of cloud-app-live-tutorial-2026-10-01 lists this
# plan's P-010 as a blocker. Exit 0 iff work-item $1 has a `blocks` edge onto
# work-item $2 in harness_shared.work_item_deps (where work_items:link stores
# blocking edges); exit 1 when no such edge exists; exit 2 on bad input.
#
# Defaults: WI-10006883 (this plan's P-010) -> WI-10004839
# (cloud-app-live-tutorial-2026-10-01#P-012, the tutorial's final release).
# Negative control: `p012-cross-plan-hold-probe.sh WI-10006876` must exit 1
# (P-003's item blocks other P- items, never the tutorial release).
#
# Read-only. Needs host context (sudo -n -u postgres), not a sandboxed shell.
# The table's rows carry workspace_id='default', so the query does not filter
# on the tenant id: blocker/blocked refs are harness-qualified already.
set -euo pipefail

blocker="${1:-WI-10006883}"
blocked="${2:-WI-10004839}"
harness="${P012_HARNESS:-papercusp}"

for id in "$blocker" "$blocked"; do
  [[ "$id" =~ ^WI-[0-9]+$ ]] || { echo "bad work-item id: $id" >&2; exit 2; }
done
[[ "$harness" =~ ^[a-z0-9-]+$ ]] || { echo "bad harness slug: $harness" >&2; exit 2; }

edges=$(sudo -n -u postgres psql -d papercusp -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM harness_shared.work_item_deps WHERE dep_type = 'blocks' AND blocker_ref = '${harness}#${blocker}' AND blocked_ref = '${harness}#${blocked}'")

echo "p012-probe blocker=${harness}#${blocker} blocked=${harness}#${blocked} edges=${edges}"
if [[ "$edges" -ge 1 ]]; then
  exit 0
fi
exit 1
